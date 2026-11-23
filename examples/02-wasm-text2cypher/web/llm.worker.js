// @ts-check
/**
 * llm.worker.js: WebLLM's engine in a dedicated module worker, so generation never blocks the
 * page. The page talks to it through WebLLM's CreateWebWorkerMLCEngine (app.js); this side is
 * WebLLM's own handler and nothing else. WebLLM (@mlc-ai/web-llm, pinned in package.json) is
 * served as one minified module from ./assets/web-llm-<version>/ (build.mjs).
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (/** @type {MessageEvent} */ msg) => handler.onmessage(msg);
