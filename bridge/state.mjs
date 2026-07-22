import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "companion-state.json";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function randomSecret(byteLength = 32) {
  return randomBytes(byteLength).toString("base64url");
}

function defaultStateDirectory(appName) {
  const explicitRoot = process.env.XDG_STATE_HOME?.trim();
  if (explicitRoot) {
    return path.join(explicitRoot, appName);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, appName);
    }
  }

  return path.join(os.homedir(), ".local", "state", appName);
}

export function resolveStatePath(options = {}) {
  const explicitPath = options.statePath || process.env.MY_ASSISTANT_BRIDGE_STATE_PATH;
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }

  const appName =
    typeof options.appName === "string" && options.appName.trim()
      ? options.appName.trim()
      : "my-assistant-web-plugin";
  const explicitDirectory = options.stateDir || process.env.MY_ASSISTANT_BRIDGE_STATE_DIR;
  const directory =
    typeof explicitDirectory === "string" && explicitDirectory.trim()
      ? path.resolve(explicitDirectory.trim())
      : defaultStateDirectory(appName);
  return path.join(directory, STATE_FILE_NAME);
}

function validateCredential(record) {
  return (
    isObject(record) &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.hash === "string" &&
    /^[a-f0-9]{64}$/u.test(record.hash) &&
    typeof record.origin === "string" &&
    record.origin.length > 0 &&
    typeof record.createdAt === "string"
  );
}

function validateState(state) {
  return (
    isObject(state) &&
    state.version === STATE_VERSION &&
    typeof state.brokerId === "string" &&
    state.brokerId.length > 0 &&
    typeof state.mcpToken === "string" &&
    state.mcpToken.length >= 32 &&
    (
      state.preferredPort === undefined ||
      state.preferredPort === null ||
      (Number.isInteger(state.preferredPort) && state.preferredPort >= 1 && state.preferredPort <= 65535)
    ) &&
    Array.isArray(state.extensionCredentials) &&
    state.extensionCredentials.every(validateCredential)
  );
}

function createInitialState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    brokerId: randomUUID(),
    mcpToken: randomSecret(),
    preferredPort: null,
    extensionCredentials: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function assertRegularStateFile(statePath) {
  try {
    const metadata = await lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Companion state path is not a regular file: ${statePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeCompanionState(statePath, state) {
  if (!validateState(state)) {
    throw new Error("Refusing to persist invalid companion state.");
  }

  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  await assertRegularStateFile(statePath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(
    {
      ...state,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;

  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    });
    if (process.platform !== "win32") {
      await chmod(temporaryPath, 0o600);
    }
    await rename(temporaryPath, statePath);
    if (process.platform !== "win32") {
      await chmod(statePath, 0o600);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function loadCompanionState(options = {}) {
  const statePath = resolveStatePath(options);
  await assertRegularStateFile(statePath);

  try {
    const serialized = await readFile(statePath, "utf8");
    const state = JSON.parse(serialized);
    if (!validateState(state)) {
      throw new Error(`Companion state is invalid or unsupported: ${statePath}`);
    }
    if (process.platform !== "win32") {
      await chmod(statePath, 0o600);
    }
    return { state, statePath, created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const state = createInitialState();
  await writeCompanionState(statePath, state);
  return { state, statePath, created: true };
}

export function isValidCompanionState(value) {
  return validateState(value);
}
