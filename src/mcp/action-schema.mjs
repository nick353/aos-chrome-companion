import * as z from 'zod/v4';
import { ACTION_EVENT_CONTRACT, AUTHORIZED_TRANSACTION_METHODS } from '../shared/operation-schema.mjs';

// Preserve broker validation and extension fields while advertising the common
// required arguments before dispatch. Unknown method-specific fields are retained.
export function transactionActionSchema(locator) {
  const text = z.string();
  const proof = z.record(z.string(), z.unknown()).describe('Unchanged signed visualProof from the matching inspect tool');
  const point = z.object({ x: z.number().min(0).max(20_000), y: z.number().min(0).max(20_000) });
  const modifiers = z.union([z.array(z.enum(['alt', 'ctrl', 'control', 'meta', 'command', 'cmd', 'shift'])), text.min(1).describe('Shortcut modifier string such as Meta+Shift')]).optional();
  const uploadConfirmation = {
    confirmationLocator: locator.describe('Exact visible attachment-ready state that will appear after this upload; must not already match before the operation').optional(),
    confirmationTimeoutMs: z.number().int().min(100).max(15000).describe('Wait for the site to accept the attachment without uploading it again').optional(),
  };
  const fields = {
    'page.query': { query: text.min(1).max(500).optional(), locator: locator.optional(), attributes: z.array(text.regex(/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u).max(100)).max(16).optional(), includeHidden: z.boolean().optional(), offset: z.number().int().min(0).max(4_999).optional(), limit: z.number().int().min(1).max(100).optional(), frameId: z.number().int().min(0).optional() },
    'page.type': { locator, text, clear: z.boolean().describe('For contenteditable, true explicitly replaces the entire editor; false inserts at selection').optional(), physicalFallback: z.enum(['disabled', 'on_verified_no_effect']).optional() },
    'page.click': { locator }, 'page.doubleClick': { locator }, 'page.hover': { locator },
    'page.setChecked': { locator, checked: z.boolean() },
    'page.pressKey': { locator, key: text.min(1) },
    'page.selectText': { locator, text: text.min(1).max(10_000).describe('Exact rendered editor text, including visible line and paragraph breaks'), occurrence: z.number().int().min(0).max(99).optional(), prefix: text.min(1).max(1_000).optional().describe('Exact rendered text immediately before the selection'), suffix: text.min(1).max(1_000).optional().describe('Exact rendered text immediately after the selection') },
    'page.selectOption': { locator, option: z.union([
      z.looseObject({ label: text.optional(), value: text.optional(), index: z.number().int().min(0).optional() })
        .refine(value => ['label', 'value', 'index'].filter(key => value[key] !== undefined).length === 1, 'Provide exactly one option label, value, or index'),
      z.array(z.looseObject({ label: text.optional(), value: text.optional(), index: z.number().int().min(0).optional() })
        .refine(value => ['label', 'value', 'index'].filter(key => value[key] !== undefined).length === 1, 'Provide exactly one option label, value, or index')),
    ]), visualProof: proof, exact: z.boolean().optional(), timeoutMs: z.number().int().min(250).max(15_000).optional() },
    'page.upload': { locator, filePath: text.min(1).describe('Absolute path to a supported local regular non-symlink file, at most 25 MiB'), ...uploadConfirmation },
    'page.uploadMultiple': { locator, filePaths: z.array(text.min(1)).min(1).max(10).describe('Absolute paths; supported regular non-symlink files, at most 25 MiB combined'), ...uploadConfirmation },
    'page.richText': { locator, operation: z.enum(['bold', 'italic', 'underline', 'heading', 'formatBlock', 'formatblock', 'unorderedList', 'unorderedlist', 'unordered-list', 'orderedList', 'orderedlist', 'ordered-list', 'indent', 'outdent', 'horizontalRule', 'horizontalrule', 'horizontal-rule']), text: text.min(1).max(10_000).optional(), blockTag: z.enum(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']).optional().describe('For heading or formatBlock; defaults to p. The selection must cover one whole block.'), occurrence: z.number().int().min(0).max(99).optional() },
    'tabs.navigate': { url: z.string().url() },
    'tabs.back': {}, 'tabs.forward': {},
    'tabs.reload': { bypassCache: z.boolean().optional() },
    'tabs.configure': { pinned: z.boolean().optional(), muted: z.boolean().optional(), index: z.number().int().min(-1).optional(), destinationWindowId: z.number().int().nonnegative().optional().describe('An existing window returned by companion_list_windows; source identity stays bound separately') },
    'page.bookmark': { title: text.max(500).optional(), parentId: text.min(1).optional() },
    'page.configureViewport': { action: z.enum(['set', 'restore']), width: z.number().int().min(200).max(3840).optional(), height: z.number().int().min(200).max(2160).optional(), deviceScaleFactor: z.number().min(0.5).max(3).optional(), durationMs: z.number().int().min(1000).max(1800000).optional().describe('Automatically clear this task-owned override; default 5 minutes. Obtain new visual proofs after set or restore.') },
    'page.scroll': { locator: locator.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().min(1).max(10_000).optional() },
    'page.submit': { locator },
    'page.waitFor': { locator, condition: z.enum(['attached', 'detached', 'visible', 'hidden']).optional().describe('Wait for the locator to be attached, detached, visible, or hidden; defaults to visible'), timeoutMs: z.number().int().min(100).max(15_000).optional() },
    'page.delay': { milliseconds: z.number().min(0).max(10_000).optional() },
    'page.download': { url: z.string().url().optional(), locator: locator.optional(), filename: text.min(1).max(240).optional() },
    'clipboard.write': { text: text.max(100_000).optional(), formats: z.array(z.object({ mimeType: z.enum(['text/plain', 'text/html', 'image/png']), dataBase64: text.min(1).max(2_796_208).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u).optional(), filePath: text.min(1).max(4096).optional().describe('Absolute local regular non-symlink file path, instead of dataBase64; read and bound on the host before signing') }).refine(value => (value.dataBase64 !== undefined) !== (value.filePath !== undefined), 'Provide exactly one dataBase64 or filePath')).min(1).max(3).optional().describe('MIME representations of one clipboard item, at most 2 MiB combined after decoding/file reads. PNG can be re-encoded and HTML normalized by Chrome; verify the actual paste separately.'), approved: z.literal(true).optional().describe('Required when formats are provided; explicit per-operation opt-in') },
    'page.handleDialog': { expectedMessage: text.max(10_000), accept: z.boolean(), expectedType: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']).optional(), expectedDialogId: text.min(1).optional(), promptText: text.max(10_000).optional().describe('Required when accepting an ordinary prompt; use an explicit empty string to submit an empty value') },
    'page.webMcpCall': { toolName: text.min(1).max(120), arguments: z.record(z.string(), z.unknown()).optional(), allowedToolNames: z.array(text.min(1).max(120)).min(1).max(32), approved: z.literal(true), maxResultBytes: z.number().int().min(1).max(262144).optional() },
    'page.nativeChooser': {},
    'tabs.claimExisting': {},
  };
  for (const method of AUTHORIZED_TRANSACTION_METHODS.filter(name => name.startsWith('visual.'))) {
    fields[method] = { visualProof: proof };
    if (['visual.pressKey', 'visual.keyDown', 'visual.keyUp'].includes(method)) Object.assign(fields[method], { key: text.min(1), modifiers, allowShortcut: z.boolean().optional(), clickBeforeKey: z.boolean().optional() });
    if (method === 'visual.typeText') Object.assign(fields[method], { text: text.min(1).max(20_000), clear: z.boolean().optional() });
    if (method === 'visual.pointerMove') Object.assign(fields[method], { virtualOnly: z.boolean().optional(), from: point.optional(), steps: z.number().int().min(1).max(60).optional() });
    if (method === 'visual.drag') Object.assign(fields[method], { toVisualProof: proof.describe('Unchanged signed visualProof for the destination, inspected in the same tab and lease as the source. The broker derives both coordinates from the two proofs.'), steps: z.number().int().min(1).max(60).optional() });
    if (method === 'visual.scroll') Object.assign(fields[method], { deltaX: z.number().min(-3000).max(3000).optional(), deltaY: z.number().min(-3000).max(3000).optional() });
    if (['visual.click', 'visual.doubleClick'].includes(method)) Object.assign(fields[method], { button: z.enum(['left', 'right', 'middle']).optional(), allowSecondaryButton: z.boolean().optional(), clickCount: z.number().int().min(1).max(2).optional(), holdMs: z.number().min(0).max(2000).optional() });
  }
  const noRequiredParams = new Set(['tabs.back', 'tabs.forward', 'tabs.reload', 'page.scroll', 'page.delay', 'page.nativeChooser', 'tabs.claimExisting', 'page.bookmark']);
  for (const method of ACTION_EVENT_CONTRACT.methods) fields[method].expectEvent = z.object({
    type: z.enum(ACTION_EVENT_CONTRACT.types),
    timeoutMs: z.number().int().min(ACTION_EVENT_CONTRACT.minTimeoutMs).max(ACTION_EVENT_CONTRACT.maxTimeoutMs).optional(),
  }).optional().describe('Arm the event before this single trigger. A dialog returns action_event_pending with its exact opening; respond in a fresh signed page.handleDialog transaction on the same tab, session and run. Never repeat the trigger.');
  return z.discriminatedUnion('method', AUTHORIZED_TRANSACTION_METHODS.map(method => {
    let params = z.looseObject(fields[method] ?? {}).describe(
      method === 'page.download' ? 'Provide exactly one URL or an exact main-frame link/media locator; returns a verified local artifact with absolute path, byte count and SHA-256 when the file is readable'
        : method === 'page.nativeChooser' ? 'Currently requires the user to choose the file; use page.upload for an available file input'
        : method === 'tabs.claimExisting' ? 'Use companion_claim_existing_tab for the separate explicit existing-tab approval flow'
          : 'Arguments for ' + method
    );
    if (method === 'page.query') params = params.refine(value => value.query || value.locator, 'Provide a query or locator');
    if (method === 'page.configureViewport') params = params.refine(value => value.action === 'restore' || (value.width !== undefined && value.height !== undefined && value.width * value.height * (value.deviceScaleFactor ?? 1) ** 2 <= 16777216), 'Set requires width/height and at most 16 megapixels');
    if (method === 'tabs.configure') params = params.refine(value => ['pinned','muted','index','destinationWindowId'].some(key => value[key] !== undefined), 'Provide a tab configuration change');
    if (method === 'page.download') params = params.refine(value => (value.url !== undefined) !== (value.locator !== undefined), 'Provide exactly one URL or locator');
    if (method === 'clipboard.write') params = params.refine(value => (value.text !== undefined) !== (value.formats !== undefined), 'Provide text or MIME formats, not both').refine(value => !value.formats || (value.approved === true && new Set(value.formats.map(format => format.mimeType)).size === value.formats.length), 'MIME writes require approved: true and unique MIME types');
    return z.object({
    method: z.literal(method),
    params: noRequiredParams.has(method) ? params.default({}) : params,
  }); }));
}
