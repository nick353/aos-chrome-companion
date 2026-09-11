#!/usr/bin/env node
import { connectPeer } from "../client/connect.mjs";
import { normalizeError } from "../shared/errors.mjs";
import { encodeNativeMessage, NativeMessageDecoder } from "../shared/framing.mjs";
import { encodeNativeCommand } from "../shared/native-command-transfer.mjs";
import { MAX_EXTENSION_MESSAGE_BYTES } from "../shared/constants.mjs";
import { convergeCompanionSetup } from "../setup/auto-setup.mjs";

const callerOrigin = process.argv[2] ?? "unknown";
const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_MESSAGE_BYTES });
const queuedMessages = [];
let peer;
let ended = false;
let setupPromise = null;

function writeNative(message) {
  if (!ended) {
    process.stdout.write(encodeNativeMessage(message));
  }
}

function fail(error) {
  writeNative({ kind: "relay.error", error: normalizeError(error), callerOrigin });
  process.stderr.write(`AOS Chrome Companion native relay: ${error?.stack ?? error}\n`);
}

function startAutoSetupOnce() {
  if (setupPromise || process.env.AOS_CHROME_COMPANION_AUTO_SETUP === "0") return;
  const extensionId = /^chrome-extension:\/\/([a-p]{32})\/$/u.exec(callerOrigin)?.[1];
  setupPromise = convergeCompanionSetup({
    trigger: "native_host",
    ...(extensionId ? { companionExtensionId: extensionId } : {}),
  }).then((setup) => {
    writeNative({
      kind: "setup.status",
      setup: {
        schema: setup.schema,
        setupComplete: setup.setup_complete === true,
        companionReady: setup.companion_ready === true,
        integrationReady: setup.integration_ready === true,
        checkedAt: setup.checked_at,
        exactBlockers: Array.isArray(setup.exact_blockers) ? setup.exact_blockers.slice(0, 8) : [],
        nextAction: setup.next_action ?? null,
      },
    });
  }).catch((error) => {
    writeNative({
      kind: "setup.status",
      setup: {
        schema: "aos_chrome_companion_auto_setup.v1",
        setupComplete: false,
        companionReady: false,
        integrationReady: false,
        checkedAt: new Date().toISOString(),
        exactBlockers: [`auto_setup_failed:${error instanceof Error ? error.message : String(error)}`],
        nextAction: "Keep both Extensions enabled; the background setup will retry.",
      },
    });
  });
}

const expectedOrigin = process.env.AOS_CHROME_COMPANION_EXTENSION_ORIGIN;
if (expectedOrigin && callerOrigin !== expectedOrigin) {
  fail(new Error(`Native relay rejected caller origin: ${callerOrigin}`));
  process.exit(1);
}

process.stdin.on("data", (chunk) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (message?.kind === "extension.hello") startAutoSetupOnce();
      if (peer) {
        peer.send(message);
      } else {
        queuedMessages.push(message);
      }
    }
  } catch (error) {
    fail(error);
    process.exitCode = 1;
    process.stdin.pause();
  }
});

process.stdin.on("end", () => {
  ended = true;
  peer?.close();
});

try {
  peer = await connectPeer({ role: "extension-relay", autoStart: true });
  peer.onMessage((message) => {
    if (ended) return;
    try {
      for (const frame of encodeNativeCommand(message)) process.stdout.write(frame);
    } catch (error) {
      if (message.kind === "command.request") {
        peer.send({ kind: "command.error", operationId: message.operationId, error: normalizeError(error) });
      } else {
        fail(error);
      }
    }
  });
  peer.onClose(() => {
    if (!ended) {
      fail(new Error("Broker connection closed"));
      ended = true;
      process.exitCode = 1;
      process.stdin.pause();
      process.stdout.end();
    }
  });
  for (const message of queuedMessages.splice(0)) {
    peer.send(message);
  }
} catch (error) {
  fail(error);
  process.exitCode = 1;
}
