/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="WebWorker" />

declare const self: ServiceWorkerGlobalScope;

import { awaitReply, getNextRequestId } from '../messaging';
import {
	getURLScope,
	isURLScoped,
	setURLScope,
	removeURLScope,
} from '../scope';
import { getPathQueryFragment } from '../utils';

/**
 * Run this function in the service worker to install the required event
 * handlers.
 *
 * @param  config
 */
export function initializeServiceWorker(config: ServiceWorkerConfiguration) {
	const {
		shouldForwardRequestToPHPServer = (
			request: Request,
			unscopedUrl: URL
		) => seemsLikeAPHPServerPath(unscopedUrl.pathname),
	} = config;

	/**
	 * Ensure the client gets claimed by this service worker right after the registration.
	 *
	 * Only requests from the "controlled" pages are resolved via the fetch listener below.
	 * However, simply registering the worker is not enough to make it the "controller" of
	 * the current page. The user still has to reload the page. If they don't an iframe
	 * pointing to /index.php will show a 404 message instead of a homepage.
	 *
	 * This activation handles saves the user reloading the page after the initial confusion.
	 * It immediately makes this worker the controller of any client that registers it.
	 */
	self.addEventListener('activate', (event) => {
		// eslint-disable-next-line no-undef
		event.waitUntil(self.clients.claim());
	});

	/**
	 * The main method. It captures the requests and loop them back to the
	 * Worker Thread using the Loopback request
	 */
	self.addEventListener('fetch', (event) => {
		let url = new URL(event.request.url);
		// If the URL lacks scope, let's try to infer it from the referer
		// URL.
		if (!isURLScoped(url)) {
			let referer;
			try {
				referer = new URL(event.request.headers.get('referer') || '');
			} catch (e) {}
			if (referer instanceof URL && isURLScoped(referer)) {
				url = setURLScope(url, getURLScope(referer)!);
			}
		}

		const unscopedUrl = removeURLScope(url);
		if (
			!isURLScoped(url) ||
			!shouldForwardRequestToPHPServer(event.request, unscopedUrl)
		) {
			// When ignoring a scoped request, let's unscope it before
			// passing it to the browser.
			if (isURLScoped(url)) {
				event.preventDefault();
				return event.respondWith(
					new Promise(async (accept) => {
						const newRequest = await cloneRequest(event.request, {
							url: unscopedUrl,
						});
						accept(fetch(newRequest));
					})
				);
			}
			// Otherwise let the browser handle the request as is.
			return;
		}

		event.preventDefault();
		return event.respondWith(
			new Promise(async (accept) => {
				console.debug(
					`[ServiceWorker] Serving request: ${getPathQueryFragment(
						removeURLScope(url)
					)}`
				);

				const { post, files } = await parsePost(event.request);
				const requestHeaders = {};
				for (const pair of (event.request.headers as any).entries()) {
					requestHeaders[pair[0]] = pair[1];
				}

				const requestedPath = getPathQueryFragment(url);
				let phpResponse;
				try {
					const message = {
						type: 'HTTPRequest',

						/**
						 * Detect scoped requests – their url starts with `/scope:`
						 *
						 * We need this mechanics because this worker broadcasts
						 * events to all the listeners across all browser tabs. Scopes
						 * helps WASM workers ignore requests meant for other WASM workers.
						 */
						scope: getURLScope(url),
						request: {
							path: requestedPath,
							method: event.request.method,
							files,
							_POST: post,
							headers: requestHeaders,
						},
					};
					console.debug(
						'[ServiceWorker] Forwarding a request to the Worker Thread',
						{ message }
					);
					const requestId = await broadcastMessageExpectReply(
						message
					);
					phpResponse = await awaitReply(self, requestId);
					console.debug(
						'[ServiceWorker] Response received from the main app',
						{ phpResponse }
					);
				} catch (e) {
					console.error(e, { requestedPath });
					throw e;
				}

				accept(
					new Response(phpResponse.body, {
						headers: phpResponse.headers,
						status: phpResponse.statusCode,
					})
				);
			})
		);
	});
}

/**
 * Sends the message to all the controlled clients
 * of this service worker.
 *
 * This used to be implemented with a BroadcastChannel, but
 * it didn't work in Safari. BroadcastChannel breaks iframe
 * embedding the playground in Safari.
 *
 * Weirdly, Safari does not pass any messages from the ServiceWorker
 * to Window if the page is rendered inside an iframe. Window to Service
 * Worker communication works just fine.
 *
 * The regular client.postMessage() communication works perfectly, so that's
 * what this function uses to broadcast the message.
 *
 * @param  message The message to broadcast.
 * @returns The request ID to receive the reply.
 */
async function broadcastMessageExpectReply(message) {
	const requestId = getNextRequestId();
	for (const client of await self.clients.matchAll()) {
		client.postMessage({
			...message,
			requestId,
		});
	}
	return requestId;
}

interface ServiceWorkerConfiguration {
	shouldForwardRequestToPHPServer?: (
		request: Request,
		unscopedUrl: URL
	) => boolean;
}

/**
 * Guesses whether the given path looks like a PHP file.
 *
 * @example
 * ```js
 * seemsLikeAPHPServerPath('/index.php') // true
 * seemsLikeAPHPServerPath('/index.php') // true
 * seemsLikeAPHPServerPath('/index.php/foo/bar') // true
 * seemsLikeAPHPServerPath('/index.html') // false
 * seemsLikeAPHPServerPath('/index.html/foo/bar') // false
 * seemsLikeAPHPServerPath('/') // true
 * ```
 *
 * @param  path The path to check.
 * @returns Whether the path seems like a PHP server path.
 */
export function seemsLikeAPHPServerPath(path: string): boolean {
	return seemsLikeAPHPFile(path) || seemsLikeADirectoryRoot(path);
}

function seemsLikeAPHPFile(path) {
	return path.endsWith('.php') || path.includes('.php/');
}

function seemsLikeADirectoryRoot(path) {
	const lastSegment = path.split('/').pop();
	return !lastSegment.includes('.');
}

async function parsePost(request) {
	if (request.method !== 'POST') {
		return { post: undefined, files: undefined };
	}
	// Try to parse the body as form data
	try {
		const formData = await request.clone().formData();
		const post = {};
		const files = {};

		for (const key of formData.keys()) {
			const value = formData.get(key);
			if (value instanceof File) {
				files[key] = value;
			} else {
				post[key] = value;
			}
		}

		return { post, files };
	} catch (e) {}

	// Try to parse the body as JSON
	return { post: await request.clone().json(), files: {} };
}

/**
 * Copy a request with custom overrides.
 *
 * This function is only needed because Request properties
 * are read-only. The only way to change e.g. a URL is to
 * create an entirely new request:
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/Request
 *
 * @param  request
 * @param  overrides
 * @returns The new request.
 */
async function cloneRequest(
	request: Request,
	overrides: Record<string, any>
): Promise<Request> {
	const body =
		['GET', 'HEAD'].includes(request.method) || 'body' in overrides
			? undefined
			: await request.blob();
	return new Request(overrides.url || request.url, {
		body,
		method: request.method,
		headers: request.headers,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
		mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
		credentials: request.credentials,
		cache: request.cache,
		redirect: request.redirect,
		integrity: request.integrity,
		...overrides,
	});
}
