// Source-tree development builds intentionally share a stable value so the
// broker and the unpacked development Extension can be exercised together.
// The local installer replaces this file in its staging tree with one unique
// install-specific value in both the Node and Extension trees.
export const INSTALL_BUILD_ID = "dev-local";
