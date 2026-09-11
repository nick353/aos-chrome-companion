import { MAX_NATIVE_MESSAGE_BYTES } from "./constants.mjs";
import { CompanionError } from "./errors.mjs";
import { StringDecoder } from "node:string_decoder";

export class NativeMessageDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body = null;
  #bodyBytes = 0;
  #maxBytes;

  constructor({ maxBytes = MAX_NATIVE_MESSAGE_BYTES } = {}) {
    this.#maxBytes = maxBytes;
  }

  push(chunk) {
    const messages = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#body === null) {
        const count = Math.min(4 - this.#headerBytes, chunk.length - offset);
        chunk.copy(this.#header, this.#headerBytes, offset, offset + count);
        offset += count;
        this.#headerBytes += count;
        if (this.#headerBytes < 4) break;
        const length = this.#header.readUInt32LE(0);
        if (length > this.#maxBytes) {
          throw new CompanionError("native_message_too_large", `Native message is ${length} bytes; limit is ${this.#maxBytes}`);
        }
        // Allocate once after checking the advertised size. Repeatedly
        // concatenating the entire prefix costs quadratic copies for large
        // clipboard replies delivered in small pipe packets.
        this.#body = Buffer.allocUnsafe(length);
        this.#bodyBytes = 0;
      }
      const count = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
      chunk.copy(this.#body, this.#bodyBytes, offset, offset + count);
      offset += count;
      this.#bodyBytes += count;
      if (this.#bodyBytes < this.#body.length) break;
      const body = this.#body.toString("utf8");
      this.#body = null;
      this.#headerBytes = 0;
      this.#bodyBytes = 0;
      try {
        messages.push(JSON.parse(body));
      } catch (error) {
        throw new CompanionError("native_message_invalid_json", error.message);
      }
    }
    return messages;
  }
}

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new CompanionError(
      "native_message_too_large",
      `Native message is ${body.length} bytes; limit is ${MAX_NATIVE_MESSAGE_BYTES}`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class JsonLineDecoder {
  #parts = [];
  #decoder = new StringDecoder("utf8");

  push(chunk) {
    const text = this.#decoder.write(chunk);
    const messages = [];
    let start = 0;
    while (true) {
      // Search only newly received text. Re-scanning and flattening a growing
      // string on every socket packet also becomes quadratic for uploads.
      const index = text.indexOf("\n", start);
      if (index < 0) {
        if (start < text.length) this.#parts.push(text.slice(start));
        break;
      }
      this.#parts.push(text.slice(start, index));
      const line = this.#parts.join("").trim();
      this.#parts = [];
      start = index + 1;
      if (line.length > 0) {
        messages.push(JSON.parse(line));
      }
    }
    return messages;
  }
}

export function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}
