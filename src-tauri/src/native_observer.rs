// Private, read-only child mode of the bundled launcher. No Tauri/UI/profile setup.
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};

fn emit(output: &Mutex<io::Stdout>, value: serde_json::Value) {
    if let Ok(mut stream) = output.lock() {
        let _ = writeln!(stream, "{value}");
        let _ = stream.flush();
    }
}

pub fn try_main() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--agent-desk-observe") {
        return None;
    }
    let output = Arc::new(Mutex::new(io::stdout()));
    let parsed = (|| {
        if args.len() != 4 {
            return None;
        }
        let pid = args[2].parse::<u32>().ok().filter(|id| *id > 0)?;
        let port = args[3].parse::<u16>().ok().filter(|port| *port >= 1024)?;
        Some((pid, port))
    })();
    let Some((pid, port)) = parsed else {
        emit(
            &output,
            serde_json::json!({"event":"fault","stage":"helper-start","reason":"invalid-request"}),
        );
        return Some(1);
    };
    #[cfg(target_os = "windows")]
    {
        Some(windows::run(pid, port, output))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, port);
        Some(1)
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::{ffi::c_void, time::Instant};
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut c_void,
            size: *mut u32,
            sort: i32,
            family: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
    }
    struct Process(*mut c_void);
    // Kernel process handles support concurrent wait/query; never request write rights.
    unsafe impl Send for Process {}
    unsafe impl Sync for Process {}
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn exited(process: &Process) -> Result<Option<u32>, ()> {
        match unsafe { WaitForSingleObject(process.0, 0) } {
            258 => Ok(None),
            0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
                    Err(())
                } else {
                    Ok(Some(code))
                }
            }
            _ => Err(()),
        }
    }
    fn table(family: u32) -> Result<Vec<u8>, u32> {
        let mut size = 0;
        let result =
            unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, family, 3, 0) };
        if result != 122 && result != 0 {
            return Err(result);
        }
        // Bounded allocation and bounded resize for concurrent OS table changes.
        for _ in 0..3 {
            if !(4..=16_777_216).contains(&size) {
                return Err(13);
            }
            let mut bytes = vec![0u8; size as usize];
            let result = unsafe {
                GetExtendedTcpTable(bytes.as_mut_ptr().cast(), &mut size, 0, family, 3, 0)
            };
            if result == 122 {
                continue;
            }
            if result != 0 {
                return Err(result);
            }
            if size as usize > bytes.len() {
                return Err(13);
            }
            bytes.truncate(size as usize);
            return Ok(bytes);
        }
        Err(122)
    }
    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }
    pub(super) fn rows(bytes: &[u8], ipv6: bool, port: u16, pid: u32) -> Result<(u32, bool), u32> {
        if bytes.len() < 4 {
            return Err(13);
        }
        let count = u32_at(bytes, 0) as usize;
        let stride = if ipv6 { 56 } else { 24 };
        if count > 131_072 || 4 + count * stride > bytes.len() {
            return Err(13);
        }
        let mut matches = 0;
        let mut owned = false;
        for row in bytes[4..4 + count * stride].chunks_exact(stride) {
            let offset = if ipv6 { 20 } else { 8 };
            if u16::from_be_bytes([row[offset], row[offset + 1]]) != port {
                continue;
            }
            if u32_at(row, if ipv6 { 48 } else { 0 }) != 2 {
                return Err(13);
            }
            matches += 1;
            owned = !ipv6 && row[4..8] == [127, 0, 0, 1] && u32_at(row, 20) == pid;
        }
        Ok((matches, owned))
    }
    pub(super) fn run(pid: u32, port: u16, output: Arc<Mutex<io::Stdout>>) -> i32 {
        let handle = unsafe { OpenProcess(0x0010_1000, 0, pid) }; // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if handle.is_null() {
            emit(
                &output,
                serde_json::json!({"event":"fault","stage":"process-handle","reason":"process-unavailable"}),
            );
            return 1;
        }
        let process = Arc::new(Process(handle));
        emit(&output, serde_json::json!({"event":"ready"}));
        let waiting = process.clone();
        let writer = output.clone();
        std::thread::spawn(move || {
            if unsafe { WaitForSingleObject(waiting.0, u32::MAX) } == 0 {
                if let Ok(Some(code)) = exited(&waiting) {
                    emit(&writer, serde_json::json!({"event":"exit","exitCode":code}));
                    std::process::exit(0);
                }
            }
            emit(
                &writer,
                serde_json::json!({"event":"fault","stage":"process-handle","reason":"process-unavailable"}),
            );
            std::process::exit(1);
        });
        let mut input = io::stdin().lock();
        let mut last_id = 0u64;
        loop {
            let mut line = Vec::new();
            match (&mut input).take(1025).read_until(b'\n', &mut line) {
                Ok(0) => return 0,
                Ok(_) if line.len() <= 1024 && line.ends_with(b"\n") => {}
                _ => return 1,
            }
            let request: serde_json::Value = match serde_json::from_slice(&line) {
                Ok(v) => v,
                Err(_) => return 1,
            };
            let id = request.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            if request.as_object().map(|v| v.len()) != Some(1)
                || id <= last_id
                || id > 1_000_000_000
            {
                return 1;
            }
            last_id = id;
            let started = Instant::now();
            if !matches!(exited(&process), Ok(None)) {
                continue;
            } // waiter reports the actual handle result
            let mut count = 0;
            let mut owned = false;
            let mut failure = None;
            for (family, ipv6, stage) in [(2, false, "listener-ipv4"), (23, true, "listener-ipv6")]
            {
                match table(family).and_then(|bytes| rows(&bytes, ipv6, port, pid)) {
                    Ok((n, yes)) => {
                        count += n;
                        owned |= yes;
                    }
                    Err(code) => {
                        failure = Some((stage, code));
                        break;
                    }
                }
            }
            let elapsed = started.elapsed().as_millis().min(30_000) as u32;
            if let Some((stage, code)) = failure {
                emit(
                    &output,
                    serde_json::json!({"event":"sample","id":id,"stage":stage,"elapsedMs":elapsed,"reason":"tcp-table-error","nativeCode":code}),
                );
            } else if matches!(exited(&process), Ok(None)) {
                emit(
                    &output,
                    serde_json::json!({"event":"sample","id":id,"stage":"listener-table","elapsedMs":elapsed,"processAlive":true,"listenerOwned":count==1 && owned}),
                );
            }
        }
    }
    use std::io::Read;
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn native_tcp_table_rejects_truncation_and_reads_exact_ipv4_owner() {
            assert!(rows(&[1, 0, 0, 0], false, 41415, 123).is_err());
            let mut data = vec![0u8; 28];
            data[0] = 1;
            data[4] = 2;
            data[8..12].copy_from_slice(&[127, 0, 0, 1]);
            data[12..14].copy_from_slice(&41415u16.to_be_bytes());
            data[24..28].copy_from_slice(&123u32.to_le_bytes());
            assert_eq!(rows(&data, false, 41415, 123), Ok((1, true)));
            assert_eq!(rows(&data, false, 41415, 124), Ok((1, false)));
            data[8] = 0;
            assert_eq!(rows(&data, false, 41415, 123), Ok((1, false)));
        }
        #[test]
        fn ipv6_listener_is_counted_but_never_trusted_as_ipv4_loopback() {
            let mut data = vec![0u8; 60];
            data[0] = 1;
            data[24..26].copy_from_slice(&41415u16.to_be_bytes());
            data[52] = 2;
            assert_eq!(rows(&data, true, 41415, 123), Ok((1, false)));
        }
    }
}
