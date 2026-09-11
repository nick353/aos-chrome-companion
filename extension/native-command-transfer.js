// Chrome accepts at most 1 MiB per native-host message. Large explicit file/MIME
// commands arrive in bounded pieces; nothing runs until the
// complete command has passed its byte count, digest and envelope checks.
export const COMMAND_CHUNK_BYTES = 384 * 1024;
export const MAX_COMMAND_TRANSFER_BYTES = 36 * 1024 * 1024;
export const TRANSFER_METHODS = new Set(["page.upload", "page.uploadMultiple", "clipboard.write"]);

function transferError(message) {
  return Object.assign(new Error(message), { code: "native_command_transfer_invalid",
    details: { operationEffectState: "none", mutationDispatchAttempted: false } });
}

export class NativeCommandAssembler {
  #pending = new Map();
  #reservedBytes = 0;
  #timeoutMs;
  #onExpire;

  constructor({ timeoutMs = 30_000, onExpire = () => {} } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#onExpire = onExpire;
  }

  #discard(id) {
    const entry = this.#pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#reservedBytes -= entry.totalBytes;
    this.#pending.delete(id);
  }

  clear() {
    for (const id of this.#pending.keys()) this.#discard(id);
  }

  async accept(packet) {
    const { operationId: id, index, count, totalBytes, sha256, dataBase64 } = packet;
    try {
      if (packet.kind !== "command.chunk" || typeof id !== "string" || id.length < 1 || id.length > 256
        || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_COMMAND_TRANSFER_BYTES
        || !Number.isSafeInteger(count) || count !== Math.ceil(totalBytes / COMMAND_CHUNK_BYTES)
        || !Number.isSafeInteger(index) || index < 0 || index >= count
        || !/^[a-f0-9]{64}$/u.test(sha256 ?? "")
        || typeof dataBase64 !== "string" || dataBase64.length > Math.ceil(COMMAND_CHUNK_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64) || dataBase64.length % 4 !== 0) {
        throw transferError("Malformed or oversized command fragment");
      }
      let entry = this.#pending.get(id);
      if (!entry) {
        if (index !== 0 || this.#pending.size >= 2 || this.#reservedBytes + totalBytes > MAX_COMMAND_TRANSFER_BYTES * 2) {
          throw transferError("Command fragment is out of order or transfer capacity is full");
        }
        entry = { totalBytes, count, sha256, profileInstanceId: packet.profileInstanceId, generation: packet.generation,
          bytes: new Uint8Array(totalBytes), nextIndex: 0, offset: 0 };
        entry.timer = setTimeout(() => {
          this.#discard(id);
          this.#onExpire(id);
        }, this.#timeoutMs);
        entry.timer.unref?.();
        this.#pending.set(id, entry);
        this.#reservedBytes += totalBytes;
      }
      if (entry.nextIndex !== index || entry.count !== count || entry.totalBytes !== totalBytes || entry.sha256 !== sha256
        || entry.profileInstanceId !== packet.profileInstanceId || entry.generation !== packet.generation) {
        throw transferError("Command fragment sequence or envelope changed");
      }
      const binary = atob(dataBase64);
      if (binary.length !== Math.min(COMMAND_CHUNK_BYTES, totalBytes - entry.offset)) {
        throw transferError("Command fragment byte count is incorrect");
      }
      for (let i = 0; i < binary.length; i += 1) entry.bytes[entry.offset + i] = binary.charCodeAt(i);
      entry.offset += binary.length;
      entry.nextIndex += 1;
      if (entry.nextIndex !== count) return null;
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", entry.bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      // Disconnect, timeout or an invalid duplicate can discard this transfer
      // while the asynchronous digest is running. Never revive it afterward.
      if (this.#pending.get(id) !== entry) throw transferError("Command transfer was discarded");
      if (digest !== sha256) throw transferError("Command transfer digest does not match");
      const command = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
      if (command.kind !== "command.request" || command.operationId !== id || !TRANSFER_METHODS.has(command.method)
        || command.profileInstanceId !== entry.profileInstanceId || command.generation !== entry.generation) {
        throw transferError("Reassembled command does not match its transfer envelope");
      }
      this.#discard(id);
      return command;
    } catch (error) {
      this.#discard(id);
      throw error?.code ? error : transferError(error.message);
    }
  }
}
