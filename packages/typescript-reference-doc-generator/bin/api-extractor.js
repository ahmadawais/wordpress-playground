require('../src/patch-tsdoc');

const colors = require('colors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExtractorConfig, Extractor } = require('@microsoft/api-extractor');

const recipe = {
	'php-wasm': ['php-wasm'],
	'php-wasm-browser': [
		'php-wasm-browser',
		'php-wasm-browser/worker-thread',
		'php-wasm-browser/service-worker',
	],
	'wordpress-wasm': [
		'wordpress-wasm',
		'wordpress-wasm/worker-thread',
		'wordpress-wasm/service-worker',
	],
};

// process.cwd;

for (const [package, entrypoints] of Object.entries(recipe)) {
	for (const entrypoint of entrypoints) {
		const configObjectFullPath = __dirname + '/../../../api-extractor.json';
		if (!fs.existsSync(configObjectFullPath)) {
			throw new Error('Config file not found: ' + configObjectFullPath);
		}

		const tmp = os.tmpdir();
		const tmpIndexPath = path.join(tmp, 'index.d.ts');
		fs.writeFileSync(tmpIndexPath, `export * from "${entrypoint}"`);
		const configObject = ExtractorConfig.loadFile(configObjectFullPath);
		configObject.mainEntryPointFilePath = tmpIndexPath;
		const extractorConfig = ExtractorConfig.prepare({
			configObject,
			configObjectFullPath,
			packageJsonFullPath:
				__dirname + `/../../../packages/${package}/package.json`,
		});

		const extractorResult = Extractor.invoke(extractorConfig, {
			localBuild: true,
			showVerboseMessages: true,
			showDiagnostics: false,
		});

		if (extractorResult.succeeded) {
			console.log('\n' + 'API Extractor completed successfully');
		} else {
			process.exitCode = 1;

			if (extractorResult.errorCount > 0) {
				console.log(
					'\n' + colors.red('API Extractor completed with errors')
				);
			} else {
				console.log(
					'\n' +
						colors.yellow('API Extractor completed with warnings')
				);
			}
			break;
		}
	}
}
