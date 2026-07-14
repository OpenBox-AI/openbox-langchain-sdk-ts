// SDK identity constants that brand every governance request this adapter makes.
//
// The base SDK composes the `X-OpenBox-SDK-Version` header as
// `openbox-{engine}-{language}-v{version}`. For this adapter that resolves to
// `openbox-langchain-typescript-v<pkg>`: engine `"langchain"`, language
// `"typescript"` (the Python adapter uses `"python"` here), and the version is
// THIS package's own version — not the base SDK version — so the header
// identifies the LangChain adapter, not the base runtime underneath it.
import { SDK_VERSION } from "./version.js";

/** Governance engine component of the SDK identifier. */
export const SDK_ENGINE = "langchain";

/** Runtime language component of the SDK identifier. */
export const SDK_LANGUAGE = "typescript";

/**
 * Version component of the SDK identifier — this package's own version, so the
 * wire header reports the adapter version rather than the base SDK's.
 */
export const SDK_PACKAGE_VERSION = SDK_VERSION;
