const { build } = require('esbuild');
const yargs = require('yargs');
const { execSync } = require('child_process');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const crypto = require('crypto');

const argv = yargs(process.argv.slice(2))
	.command('build', 'Builds the project files')
	.options({
		platform: {
			type: 'string',
			default: 'browser',
			describe: 'The platform to build for.',
			choices: ['browser'],
		},
		watch: {
			type: 'boolean',
			default: false,
			describe: 'Should watch the files and rebuild on change?',
		},
	})
	.help()
	.alias('help', 'h').argv;

// Attached to all script URLs to force browsers to download the
// resources again.
const CACHE_BUSTER = Math.random().toFixed(16).slice(2);

// Provided by esbuild – see build.js in the repo root.
const serviceWorkerOrigin =
	process.env.SERVICE_WORKER_ORIGIN || 'http://127.0.0.1:8777';
const serviceWorkerUrl = `${serviceWorkerOrigin}/service-worker.js`;
const wasmWorkerBackend = process.env.WASM_WORKER_BACKEND || 'iframe';
let workerThreadScript;
if (wasmWorkerBackend === 'iframe') {
	const wasmWorkerOrigin =
		process.env.WASM_WORKER_ORIGIN || 'http://127.0.0.1:8777';
	workerThreadScript = `${wasmWorkerOrigin}/iframe-worker.html?${CACHE_BUSTER}`;
} else {
	workerThreadScript = `${serviceWorkerOrigin}/worker-thread.js?${CACHE_BUSTER}`;
}

const globalOutDir = 'build';

async function main() {
	build({
		logLevel: 'info',
		platform: argv.platform,
		define: {
			CACHE_BUSTER: JSON.stringify(CACHE_BUSTER),
			'process.env.BUILD_PLATFORM': JSON.stringify(argv.platform),
			SERVICE_WORKER_URL: JSON.stringify(serviceWorkerUrl),
			WASM_WORKER_THREAD_SCRIPT_URL: JSON.stringify(workerThreadScript),
			WASM_WORKER_BACKEND: JSON.stringify(wasmWorkerBackend),
			WP_JS_HASH: JSON.stringify(
				hashFiles([`packages/wordpress-wasm/build-wp/wp.js`])
			),
			PHP_JS_HASH: JSON.stringify(
				hashFiles([`packages/php-wasm/build-wasm/php.js`])
			),
		},
		outdir: globalOutDir,
		watch: argv.watch,
		target: ['chrome106', 'firefox100', 'safari15'],
		bundle: true,
		external: ['xmlhttprequest'],
		nodePaths: ['packages'],
		loader: {
			'.php': 'text',
		},
		entryPoints: {
			'service-worker': 'packages/wordpress-wasm/src/service-worker.ts',
			'worker-thread': 'packages/wordpress-wasm/src/worker-thread.ts',
			app: 'packages/wordpress-wasm/src/example-app.ts',
		},
	});
	build({
		logLevel: 'info',
		platform: 'node',
		outfile: './build-scripts/generate-reference-docs.js',
		bundle: true,
		entryPoints: [
			'./packages/typescript-reference-doc-generator/bin/generate-docs.js',
		],
		watch: argv.watch,
	});

	console.log('');
	console.log('Static files copied: ');
	mapGlob(`src/*/*.html`, (filePath) =>
		buildHTMLFile(globalOutDir, filePath)
	);
	mapGlob(`src/*/*.php`, (filePath) => copyToDist(globalOutDir, filePath));
	if (argv.watch) {
		const liveServer = require('live-server');
		const request = require('request');

		liveServer.start({
			port: 8777,
			root: __dirname + '/build',
			open: '/wordpress.html',
			middleware: [
				(req, res, next) => {
					if (req.url.startsWith('/scope:')) {
						req.url = '/' + req.url.split('/').slice(2).join('/');
					}
					if (req.url.endsWith('iframe-worker.html')) {
						res.setHeader('Origin-Agent-Cluster', '?1');
					} else if (req.url.startsWith('/plugin-proxy')) {
						const url = new URL(req.url, 'http://127.0.0.1:8777');
						const pluginName = url.searchParams
							.get('plugin')
							.replace(/[^a-zA-Z0-9\.\-_]/, '');
						request(
							`https://downloads.wordpress.org/plugin/${pluginName}`
						).pipe(res);
						return;
					}
					next();
				},
			],
		});
	}
}

if (require.main === module) {
	main();
}
exports.main = main;

function mapGlob(pattern, mapper) {
	glob.sync(pattern).map(mapper).forEach(logBuiltFile);
	if (argv.watch) {
		chokidar.watch(pattern).on('change', mapper);
	}
}

function copyToDist(outdir, filePath) {
	const filename = filePath.split('/').pop();
	const outPath = `${outdir}/${filename}`;
	fs.copyFileSync(filePath, outPath);
	return outPath;
}

function buildHTMLFile(outdir, filePath) {
	let content = fs.readFileSync(filePath).toString();
	content = content.replace(
		/(<script[^>]+src=")([^"]+)("><\/script>)/,
		`$1$2?${CACHE_BUSTER}$3`
	);
	const filename = filePath.split('/').pop();
	const outPath = `${outdir}/${filename}`;
	fs.writeFileSync(outPath, content);
	return outPath;
}

function logBuiltFile(outPath) {
	const outPathToLog = outPath.replace(/^\.\//, '');
	console.log(`  ${outPathToLog}`);
}

function fileSize(filePath) {
	if (!fs.existsSync(filePath)) {
		return 0;
	}
	return fs.statSync(filePath).size;
}

function hashFiles(filePaths) {
	// if all files exist
	if (!filePaths.every(fs.existsSync)) {
		return '';
	}
	return sha256(
		Buffer.concat(filePaths.map((filePath) => fs.readFileSync(filePath)))
	);
}

function sha256(buffer) {
	const hash = crypto.createHash('sha256');
	hash.update(buffer);
	return hash.digest('hex');
}
