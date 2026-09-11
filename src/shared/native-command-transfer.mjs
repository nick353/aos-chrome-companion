import { createHash } from "node:crypto";
import { MAX_NATIVE_MESSAGE_BYTES } from "./constants.mjs";
import { encodeNativeMessage } from "./framing.mjs";
import { CompanionError } from "./errors.mjs";
import { COMMAND_CHUNK_BYTES, MAX_COMMAND_TRANSFER_BYTES, TRANSFER_METHODS } from "../../extension/native-command-transfer.js";

export function* encodeNativeCommand(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length <= MAX_NATIVE_MESSAGE_BYTES) {
    yield encodeNativeMessage(message);
    return;
  }
  if (message.kind !== "command.request" || !TRANSFER_METHODS.has(message.method) || body.length > MAX_COMMAND_TRANSFER_BYTES) {
    throw new CompanionError("native_message_too_large", "Only bounded explicit uploads and clipboard writes support fragmented native transport",
      { operationEffectState: "none", mutationDispatchAttempted: false });
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const count = Math.ceil(body.length / COMMAND_CHUNK_BYTES);
  for (let index = 0; index < count; index += 1) {
    yield encodeNativeMessage({
      kind: "command.chunk", operationId: message.operationId,
      profileInstanceId: message.profileInstanceId, generation: message.generation,
      index, count, totalBytes: body.length, sha256,
      dataBase64: body.subarray(index * COMMAND_CHUNK_BYTES, (index + 1) * COMMAND_CHUNK_BYTES).toString("base64"),
    });
  }
}
