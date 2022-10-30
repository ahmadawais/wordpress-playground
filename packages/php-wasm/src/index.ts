export { startPHP } from "./php"

import PHPServer from "./php-server"
export { PHPServer };

import PHPBrowser from "./php-browser";
export { PHPBrowser };

// Provided by esbuild – see build.js in the repo root.
declare var PHP_JS_HASH: any;
export const phpJsHash = PHP_JS_HASH;
