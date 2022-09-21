#!/bin/bash

set -e

touch `pwd`/docker-output/node-php.js.mem
docker build . --tag=wasm-wordpress-php-builder
docker run \
        -v `pwd`/preload:/preload \
        -v `pwd`/docker-output:/output \
        wasm-wordpress-php-builder:latest \
        emcc -O3 \
        -o /output/webworker-php.js \
        --llvm-lto 2                     \
        -s EXPORTED_FUNCTIONS='["_pib_init", "_pib_destroy", "_pib_run", "_pib_exec" "_pib_refresh", "_main", "_php_embed_init", "_php_embed_shutdown", "_php_embed_shutdown", "_zend_eval_string", "_exec_callback", "_del_callback"]' \
        -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall", "UTF8ToString", "lengthBytesUTF8", "FS", "PROXYFS"]' \
        -s MAXIMUM_MEMORY=-1             \
        -s INITIAL_MEMORY=1024MB \
        -s ALLOW_MEMORY_GROWTH=1         \
        -s ASSERTIONS=0                  \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0  \
        -s EXPORT_NAME="'PHP'"           \
        -s MODULARIZE=1                  \
        -s INVOKE_RUN=0                  \
                /root/lib/pib_eval.o /root/lib/libphp7.a /root/lib/lib/libxml2.a \
        --pre-js /preload/webworker-pre-php.js \
        -s ENVIRONMENT=worker \
        -s FORCE_FILESYSTEM=1

# -fno-exceptions
