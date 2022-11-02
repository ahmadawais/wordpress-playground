/**
 * Implements request/response dynamics on top of JavaScript's `postMessage`
 *
 * @example
 *
 * In the main app:
 *
 * ```js
 * import { postMessageExpectReply, awaitReply } from 'php-wasm-browser';
 * const iframeWindow = iframe.contentWindow;
 * const requestId = postMessageExpectReply(iframeWindow, {
 *    type: "get_php_version"
 * });
 * const response = await awaitReply(iframeWindow, requestId);
 * console.log(response);
 * // "8.0.24"
 * ```
 *
 * In the iframe:
 *
 * ```js
 * import { responseTo } from 'php-wasm-browser';
 * window.addEventListener('message', (event) => {
 *    let response = '8.0.24';
 *    if(event.data.type === 'get_php_version') {
 *       response = '8.0.24';
 *    } else {
 *       throw new Error(`Unexpected message type: ${event.data.type}`);
 *    }
 *
 *    // When `requestId` is present, the other thread expects a response:
 *    if (event.data.requestId) {
 *       const response = responseTo(event.data.requestId, response);
 *       window.parent.postMessage(response, event.origin);
 *    }
 * });
 * ```
 */

const DEFAULT_RESPONSE_TIMEOUT = 25000;

let lastRequestId = 0;

/**
 * Posts a message branded with a unique `requestId` to the given `target`.
 * Then returns the `requestId` so it can be used to await a reply.
 *
 * @param  target          An object that has a `postMessage` method.
 * @param  message         A key-value object that can be serialized to JSON.
 * @param  postMessageArgs Additional arguments to pass to `postMessage`.
 * @returns The message ID for awaitReply().
 */
export function postMessageExpectReply(
	target: PostMessageTarget,
	message: Record<string, any>,
	...postMessageArgs: any[]
): number {
	const requestId = ++lastRequestId;
	target.postMessage(
		{
			...message,
			requestId,
		},
		...postMessageArgs
	);
	return requestId;
}

/**
 * Awaits a reply to the message with the given ID.
 *
 * @throws {@link Error} If the reply is not received within the timeout.
 * @param  messageTarget EventEmitter emitting `message` events, e.g. `window`
 *                       or a `Worker` instance.
 * @param  requestId     The message ID returned by postMessageExpectReply().
 * @param  timeout       The number of milliseconds to wait for a reply before
 *                       throwing an error.
 * @returns The reply from the messageTarget.
 */
export function awaitReply(
	messageTarget: EventTarget,
	requestId: number,
	timeout: number = DEFAULT_RESPONSE_TIMEOUT
): Promise<any> {
	return new Promise((resolve, reject) => {
		const responseHandler = (event) => {
			if (
				event.data.type === 'response' &&
				event.data.requestId === requestId
			) {
				messageTarget.removeEventListener('message', responseHandler);
				clearTimeout(failOntimeout);
				resolve(event.data.response);
			}
		};

		const failOntimeout = setTimeout(() => {
			reject(new Error('Request timed out'));
			messageTarget.removeEventListener('message', responseHandler);
		}, timeout);

		messageTarget.addEventListener('message', responseHandler);
	});
}

/**
 * Creates a response message to the given message ID.
 *
 * @param  requestId The message ID sent from the other thread by
 *                   `postMessageExpectReply` in the `message` event.
 * @param  response  The response to send back to the messageTarget.
 * @returns A message object that can be sent back to the other thread.
 */
export function responseTo<T>(
	requestId: number,
	response: T
): MessageResponse<T> {
	return {
		type: 'response',
		requestId,
		response,
	};
}

interface MessageResponse<T> {
	type: 'response';
	requestId: number;
	response: T;
}

interface PostMessageTarget {
	postMessage(message: any, ...args: any[]): void;
}

interface EventTarget {
	addEventListener(message: string, ...args);
	removeEventListener(message: string, ...args);
}
