const STR = "string";
const NUM = "number";

type JavascriptRuntime = 'NODE' | 'WEB' | 'WEBWORKER';

interface Streams {
  stdout: string[],
  stderr: string[],
};

/**
 * Initializes the PHP runtime with the given arguments and data dependencies.
 * 
 * This function handles the entire PHP initialization pipeline. In particular, it:
 * * Instantiates the Emscripten PHP module
 * * Wires it together with the data dependencies and loads them
 * * Ensures is all happens in a correct order
 * * Waits until the entire loading sequence is finished
 * 
 * Basic usage:
 * 
 * ```js
 *  const phpLoaderModule = await import("/php.js");
 *  const php = await startPHP(phpLoaderModule, "web");
 *  console.log(php.run(`<?php echo "Hello, world!"; `));
 *  // { stdout: "Hello, world!", stderr: [''], exitCode: 0 }
 * ```
 * 
 * **The `/php.js` module:**
 * 
 * In the basic usage example, `php.js` is **not** a vanilla Emscripten module. Instead,
 * it's an ESM module that wraps the regular Emscripten output and adds some
 * extra functionality. It's generated by the Dockerfile shipped with this repo.
 * Here's the API it provides:
 * 
 * ```js
 * // php.wasm size in bytes:
 * export const dependenciesTotalSize = 5644199;
 * 
 * // php.wasm filename:
 * export const dependencyFilename = 'php.wasm'; 
 * 
 * // Run Emscripten's generated module:
 * export default function(jsEnv, emscriptenModuleArgs) {}
 * ```
 * 
 * **PHP Filesystem:**
 * 
 * Once initialized, the PHP has its own filesystem separate from the project
 * files. It's provided by [Emscripten and uses its FS library](https://emscripten.org/docs/api_reference/Filesystem-API.html).
 * 
 * The API exposed to you via the PHP class is succinct and abstracts
 * await certain unintuitive parts of low-level FS interactions.
 * 
 * Here's how to use it:
 * 
 * ```js
 * // Recursively create a /var/www directory
 * php.mkdirTree('/var/www'); 
 * 
 * console.log(php.fileExists('/var/www/file.txt'));
 * // false
 * 
 * php.writeFile('/var/www/file.txt', 'Hello from the filesystem!');
 * 
 * console.log(php.fileExists('/var/www/file.txt'));
 * // true
 * 
 * console.log(php.readFile('/var/www/file.txt'));
 * // "Hello from the filesystem!
 * 
 * // Delete the file:
 * php.unlink('/var/www/file.txt');
 * ```
 * 
 * For more details consult the PHP class directly.
 * 
 * **Data dependencies:**
 * 
 * Using existing PHP packages by manually recreating them file-by-file would
 * be quite inconvenient. Fortunately, Emscripten provides a "data dependencies"
 * feature.
 * 
 * Data dependencies consist of a `dependency.data` file and a `dependency.js` loader and
 * can be packaged with the [file_packager.py tool]( https://emscripten.org/docs/porting/files/packaging_files.html#packaging-using-the-file-packager-tool).
 * This project requires wrapping the Emscripten-generated `dependency.js` file in an ES
 * module as follows:
 * 
 * 1. Prepend `export default function(emscriptenPHPModule) {'; `
 * 2. Prepend `export const dependencyFilename = '<DATA FILE NAME>'; `
 * 3. Prepend `export const dependenciesTotalSize = <DATA FILE SIZE>;`
 * 4. Append `}`
 * 
 * Be sure to use the `--export-name="emscriptenPHPModule"` file_packager.py option.
 * 
 * You want the final output to look as follows:
 * 
 * ```js
 * export const dependenciesTotalSize = 5644199;
 * export const dependencyFilename = 'dependency.data'; 
 * export default function(emscriptenPHPModule) {
 *    // Emscripten-generated code:
 *    var Module = typeof emscriptenPHPModule !== 'undefined' ? emscriptenPHPModule : {};
 *    // ... the rest of it ...
 * }
 * ```
 * 
 * Such a constructions enables loading the `dependency.js` as an ES Module using
 * `import("/dependency.js")`.
 * 
 * Once it's ready, you can load PHP and your data dependencies as follows:
 * 
 * ```js
 *  const [phpLoaderModule, wordPressLoaderModule] = await Promise.all([
 *    import("/php.js"),
 *    import("/wp.js") 
 *  ]);
 *  const php = await startPHP(phpLoaderModule, "web", {}, [wordPressLoaderModule]);
 * ```
 * 
 * @public
 * @param phpLoaderModule - The ESM-wrapped Emscripten module. Consult the Dockerfile for the build process.
 * @param runtime - The current JavaScript environment. One of: NODE, WEB, or WEBWORKER.
 * @param phpModuleArgs - The Emscripten module arguments, see https://emscripten.org/docs/api_reference/module.html#affecting-execution.
 * @param dataDependenciesModules - A list of the ESM-wrapped Emscripten data dependency modules.
 * @returns PHP instance. 
 */
export async function startPHP(
  phpLoaderModule: any,
  runtime: JavascriptRuntime,
  phpModuleArgs: any = {},
  dataDependenciesModules: any[] = []
): Promise<PHP> {
    let resolvePhpReady, resolveDepsReady;
    const depsReady = new Promise(resolve => { resolveDepsReady = resolve; });
    const phpReady = new Promise(resolve => { resolvePhpReady = resolve; });

    const streams: Streams = {
      stdout: [],
      stderr: [],
    };
    const loadPHPRuntime = phpLoaderModule.default;
    const PHPRuntime = loadPHPRuntime(runtime, {
      onAbort(reason) {
        console.error("WASM aborted: ");
        console.error(reason);
      },
      print: (...chunks) => streams.stdout.push(...chunks),
      printErr: (...chunks) => streams.stderr.push(...chunks),
      ...phpModuleArgs,
      noInitialRun: true,
      onRuntimeInitialized() {
        if (phpModuleArgs.onRuntimeInitialized) {
          phpModuleArgs.onRuntimeInitialized();
        }
        resolvePhpReady();
      },
      monitorRunDependencies(nbLeft) {
        if (nbLeft === 0) {
          delete PHPRuntime.monitorRunDependencies;
          resolveDepsReady();
        }
      }
    });
    for (const { default: loadDataModule } of dataDependenciesModules) {
      loadDataModule(PHPRuntime);
    }
    if (!dataDependenciesModules.length) {
      resolveDepsReady();
    }

    await depsReady;
    await phpReady;
    return new PHP(
      PHPRuntime,
      streams
    )
}
  
/**
 * An environment-agnostic wrapper around the Emscripten PHP runtime
 * that abstracts the super low-level API and provides a more convenient
 * higher-level API.
 * 
 * It exposes a minimal set of methods to run PHP scripts and to
 * interact with the PHP filesystem.
 * 
 * @public
 * @see {startPHP} This class is not meant to be used directly. Use `startPHP` instead.
 */
export class PHP {

  #Runtime;
  #streams;

  /**
   * Initializes a PHP runtime.
   * 
   * @param Runtime - PHP Runtime as initialized by startPHP.
   * @param streams - An object pointing to stdout and stderr streams, as initilized by startPHP.
   */
  constructor(PHPRuntime: any, streams: Streams) {
    this.#Runtime = PHPRuntime;
    this.#streams = streams;

    this.mkdirTree('/usr/local/etc');
    // @TODO: make this customizable
    this.writeFile('/usr/local/etc/php.ini', `[PHP]
error_reporting = E_ERROR | E_PARSE
display_errors = 1
html_errors = 1
display_startup_errors = On
session.save_path=/home/web_user
    `);
    this.#Runtime.ccall("phpwasm_init_context", NUM, [STR], []);
  }

  /**
   * Runs a PHP script and outputs an object with three properties:
   * stdout, stderr, and the exitCode.
   * 
   * * `exitCode` – the exit code of the script. `0` is a success, while `1` and `2` indicate an error.
   * * `stdout` – containing the output from `echo`, `print`, inline HTML etc.
   * * `stderr` – containing all the errors are logged. It can also be written
   *              to explicitly:
   * 
   * ```js
   * console.log(php.run(`<?php
   *  $fp = fopen('php://stderr', 'w');
   *  fwrite($fp, "Hello, world!");
   * `));
   * // {"exitCode":0,"stdout":"","stderr":["Hello, world!"]}
   * ```
   * 
   * @example
   * 
   * ```js
   * const output = php.run('<?php echo "Hello world!";');
   * console.log(output.stdout); // "Hello world!"
   * ```
   * 
   * @param code - The PHP code to run.
   * @returns The PHP process output.
   */
  run(code: string): PHPOutput {
    const exitCode = this.#Runtime.ccall("phpwasm_run", NUM, [STR], [`?>${code}`]);
    const response = {
      exitCode,
      stdout: this.#streams.stdout.join("\n"),
      stderr: this.#streams.stderr,
    };
    this.#refresh();
    return response;
  }

  /**
   * Destroys the current PHP context and creates a new one.
   * Any variables, functions, classes, etc. defined in the previous
   * context will be lost. This methods needs to always be called after
   * running PHP code, or else the next call to `run` will be contaminated
   * with the previous context.
   * 
   * @private
   */
  #refresh() {
    this.#Runtime.ccall("phpwasm_refresh", NUM, [], []);
    this.#streams.stdout = [];
    this.#streams.stderr = [];
  }

  /**
   * Recursively creates a directory with the given path in the PHP filesystem.
   * For example, if the path is `/root/php/data`, and `/root` already exists,
   * it will create the directories `/root/php` and `/root/php/data`.
   * 
   * @param path - The directory path to create.
   */
  mkdirTree(path: string) {
    this.#Runtime.FS.mkdirTree(path);
  }
  
  /**
   * Reads a file from the PHP filesystem and returns it as a string.
   * 
   * @throws {FS.ErrnoError} If the file doesn't exist.
   * @param path - The file path to read.
   * @returns The file contents.
   */
  readFileAsText(path: string): string {
    return new TextDecoder().decode(this.readFileAsBuffer(path));
  }

  /**
   * Reads a file from the PHP filesystem and returns it as an array buffer.
   * 
   * @throws {FS.ErrnoError} If the file doesn't exist.
   * @param path - The file path to read.
   * @returns The file contents.
   */
  readFileAsBuffer(path: string): Uint8Array {
    return this.#Runtime.FS.readFile(path);
  }

  /**
   * Overwrites data in a file in the PHP filesystem.
   * Creates a new file if one doesn't exist yet.
   * 
   * @param path - The file path to write to.
   * @param data - The data to write to the file.
   */
  writeFile(path: string, data: string|Uint8Array) {
    return this.#Runtime.FS.writeFile(path, data);
  }

  /**
   * Removes a file from the PHP filesystem.
   * 
   * @throws {FS.ErrnoError} If the file doesn't exist.
   * @param path - The file path to remove.
   */
  unlink(path: string) {
    this.#Runtime.FS.unlink(path);
  }

  /**
   * Checks if a file (or a directory) exists in the PHP filesystem.
   * 
   * @param path - The file path to check.
   * @returns True if the file exists, false otherwise.
   */
  fileExists(path: string): boolean {
    try {
      this.#Runtime.FS.lookupPath(path);
      return true;
    } catch(e) {
      return false;
    }
  }

  /**
   * Allocates an internal HashTable to keep track of the legitimate uploads.
   * 
   * Supporting file uploads via WebAssembly is a bit tricky.
   * Functions like `is_uploaded_file` or `move_uploaded_file` fail to work
   * with those $_FILES entries that are not in an internal hash table. This
   * is a security feature, see this exceprt from the `is_uploaded_file` documentation:
   * 
   * > is_uploaded_file
   * > 
   * > Returns true if the file named by filename was uploaded via HTTP POST. This is
   * > useful to help ensure that a malicious user hasn't tried to trick the script into
   * > working on files upon which it should not be working--for instance, /etc/passwd.
   * > 
   * > This sort of check is especially important if there is any chance that anything
   * > done with uploaded files could reveal their contents to the user, or even to other
   * > users on the same system.
   * > 
   * > For proper working, the function is_uploaded_file() needs an argument like
   * > $_FILES['userfile']['tmp_name'], - the name of the uploaded file on the client's
   * > machine $_FILES['userfile']['name'] does not work.
   * 
   * This PHP.wasm implementation doesn't run any PHP request machinery, so PHP never has
   * a chance to note which files were actually uploaded. In practice, `is_uploaded_file()`
   * always returns false.
   * 
   * `initUploadedFilesHash()`, `registerUploadedFile()`, and `destroyUploadedFilesHash()`
   * are a workaround for this problem. They allow you to manually register uploaded
   * files in the internal hash table, so that PHP functions like `move_uploaded_file()`
   * can recognize them.
   *  
   * Usage:
   * 
   * ```js
   * // Create an uploaded file in the PHP filesystem.
   * php.writeFile(
   *    '/tmp/test.txt',
   *    'I am an uploaded file!'
   * );
   * 
   * // Allocate the internal hash table.
   * php.initUploadedFilesHash();
   * 
   * // Register the uploaded file.
   * php.registerUploadedFile('/tmp/test.txt');
   * 
   * // Run PHP code that uses the uploaded file.
   * php.run(`<?php
   * 	_FILES[key] = {
	 *		  name: value.name,
	 *			type: value.type,
	 *			tmp_name: tmpPath,
	 *			error: 0,
	 *			size: value.size,
	 *	};
   *  var_dump(is_uploaded_file($_FILES["file1"]["tmp_name"]));
   *  // true
   * `);
   * 
   * // Destroy the internal hash table to free the memory.
   * php.destroyUploadedFilesHash();
   * ```
   */
  initUploadedFilesHash() {
    this.#Runtime.ccall("phpwasm_init_uploaded_files_hash", null, [], []);
  }

  /**
   * Registers an uploaded file in the internal hash table.
   * 
   * @see initUploadedFilesHash()
   * @param tmpPath - The temporary path of the uploaded file.
   */
  registerUploadedFile(tmpPath: string) {
    this.#Runtime.ccall("phpwasm_register_uploaded_file", null, [STR], [tmpPath]);
  }

  /**
   * Destroys the internal hash table to free the memory.
   * 
   * @see initUploadedFilesHash()
   */
  destroyUploadedFilesHash() {
    this.#Runtime.ccall("phpwasm_destroy_uploaded_files_hash", null, [], []);
  }

}

/**
 * Output of the PHP.wasm runtime.
 */
export interface PHPOutput {
  /** Exit code of the PHP process. 0 means success, 1 and 2 mean error. */
  exitCode: number;

  /** Stdout data */
  stdout: string;

  /** Stderr lines */
  stderr: string[];
}
