const REFERENCE_FORMAT = "taskboard.composer-reference.v1";
const REFERENCE_PREFIX = "taskboard://composer-reference/v1";
const REFERENCE_KINDS = new Set(["skill", "agent"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function encodeReferenceKey(stableId) {
  return Buffer.from(requiredString(stableId, "stableId"), "utf8").toString("base64url");
}

export function decodeComposerReferenceKey(referenceKey) {
  const key = requiredString(referenceKey, "referenceKey");
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new TypeError("referenceKey must be unpadded base64url");
  }
  const decoded = Buffer.from(key, "base64url").toString("utf8");
  if (!decoded || encodeReferenceKey(decoded) !== key) {
    throw new TypeError("referenceKey is not canonical base64url UTF-8");
  }
  return decoded;
}

function assertReferenceKind(kind) {
  if (!REFERENCE_KINDS.has(kind)) {
    throw new TypeError("kind must be 'skill' or 'agent'");
  }
  return kind;
}

function escapedMarkdownLabel(label) {
  return requiredString(label, "label").replace(/[\\[\]]/g, "\\$&");
}

export function composerReferenceUri(kind, stableId) {
  return `${REFERENCE_PREFIX}/${assertReferenceKind(kind)}/${encodeReferenceKey(stableId)}`;
}

export function composerReferencePersistence(kind, stableId, label) {
  const normalizedStableId = kind === "skill"
    ? requiredString(stableId, "stableId").normalize("NFC")
    : requiredString(stableId, "stableId");
  const referenceKey = encodeReferenceKey(normalizedStableId);
  const uri = `${REFERENCE_PREFIX}/${assertReferenceKind(kind)}/${referenceKey}`;
  return {
    format: REFERENCE_FORMAT,
    kind,
    referenceKey,
    markdown: `[${escapedMarkdownLabel(label)}](${uri})`,
  };
}

export function parseComposerReferenceUri(uri) {
  const value = requiredString(uri, "uri");
  const match = /^taskboard:\/\/composer-reference\/v1\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new TypeError("uri is not a composer reference v1 URI");
  const kind = assertReferenceKind(match[1]);
  const stableId = decodeComposerReferenceKey(match[2]);
  if (kind === "skill" && stableId !== stableId.normalize("NFC")) {
    throw new TypeError("skill reference identity must use NFC normalization");
  }
  return { format: REFERENCE_FORMAT, kind, referenceKey: match[2], stableId };
}

export const COMPOSER_REFERENCE_FORMAT = REFERENCE_FORMAT;
