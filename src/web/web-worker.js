/* eslint-disable no-inner-declarations */

import PHPWrapper from '../shared/php-wrapper.mjs';

console.log( '[WebWorker] Spawned' );

// Polyfill for the emscripten loader
document = {};

importScripts( '/webworker-php.js' );

const php = new PHPWrapper( );

// async function init() {
//
// 	await php.init( PHP, {} );
// 	console.log( 'loaded' );
// }
//
// init();
