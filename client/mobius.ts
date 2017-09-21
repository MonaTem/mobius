import { Channel, JsonValue } from "mobius-types";
import { interceptGlobals } from "determinism";
import { logOrdering, roundTrip, eventForValue, eventForException, parseValueEvent, serializeMessageAsText, deserializeMessageFromText, disconnectedError, Event, ServerMessage, ClientMessage, BootstrapData } from "_internal";
/**
 * @license THE MIT License (MIT)
 * 
 * Copyright (c) 2017 Ryan Petrich
 * Copyright (c) 2017 Jason Miller
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
if (/\bMSIE [1-8]\b/.test(navigator.userAgent) || !("addEventListener" in window) || typeof JSON == "undefined") {
	const fallbackScript = document.createElement("script");
	fallbackScript.src = "fallback.js";
	document.head.appendChild(fallbackScript);
	throw "Insufficient browser support. Falling back to server-side rendering...";
}

const setTimeout = window.setTimeout;
const clearTimeout = window.clearTimeout;

type Task = () => void;
function isPromiseLike<T>(value: T | Promise<T> | undefined) : value is Promise<T> {
	return typeof value == "object" && "then" in (value as any);
}

const microTaskQueue : Task[] = [];
const taskQueue : Task[] = [];

const { scheduleFlushTasks, setImmediate } = (() => {
	let setImmediate: (callback: () => void) => void = window.setImmediate;
	let scheduleFlushTasks: (() => void) | undefined;
	// Attempt postMessage, but only if it's asynchronous
	if (!setImmediate && window.postMessage) {
		let isAsynchronous = true;
		const synchronousTest = () => isAsynchronous = false;
		window.addEventListener("message", synchronousTest, false);
		window.postMessage("__mobius_test", "*");
		window.removeEventListener("message", synchronousTest, false);
		if (isAsynchronous) {
			window.addEventListener("message", flushTasks, false);
			scheduleFlushTasks = () => {
				window.postMessage("__mobius_flush", "*")
			};
		}
	}
	// Try a <script> tag's onreadystatechange
	if (!setImmediate && "onreadystatechange" in document.createElement("script")) {
		setImmediate = callback => {
			const script = document.createElement("script");
			(script as any).onreadystatechange = () => {
				document.head.removeChild(script);
				callback();
			};
			document.head.appendChild(script);
		};
	}
	// Try requestAnimationFrame
	if (!setImmediate) {
		const requestAnimationFrame = window.requestAnimationFrame || (window as any).webkitRequestRequestAnimationFrame || (window as any).mozRequestRequestAnimationFrame;
		if (requestAnimationFrame) {
			setImmediate = requestAnimationFrame;
		}
	}
	// Fallback to setTimeout(..., 0)
	if (!setImmediate) {
		setImmediate = callback => {
			setTimeout.call(window, callback, 0);
		}
	}
	return { scheduleFlushTasks: scheduleFlushTasks || setImmediate.bind(window, flushTasks), setImmediate };
})();

function flushMicroTasks() {
	let task: Task | undefined;
	while (task = microTaskQueue.shift()) {
		task();
	}
}

function flushTasks() {
	let completed: boolean | undefined;
	try {
		flushMicroTasks();
		let task = taskQueue.shift();
		if (task) {
			task();
		}
		completed = !taskQueue.length;
	} finally {
		if (!completed) {
			scheduleFlushTasks();
		}
	}
}

function submitTask(queue: Task[], task: Task) {
	queue.push(task);
	if (microTaskQueue.length + taskQueue.length == 1) {
		scheduleFlushTasks();
	}
}

// Setup bundled Promise implementation if native implementation doesn't schedule as micro-tasks or is not present
if (!("Promise" in (window as any)) || !/^Google |^Apple /.test(navigator.vendor)) {
	(window as any).Promise = bundledPromiseImplementation();
}

const resolvedPromise: Promise<void> = Promise.resolve();

function defer() : Promise<void>;
function defer<T>() : Promise<T>;
function defer(value?: any) : Promise<any> {
	return new Promise<any>(resolve => submitTask(taskQueue, resolve.bind(null, value)));
}

function escape(e: any) {
	setImmediate(() => {
		throw e;
	});
}

function escaping(handler: () => any | Promise<any>) : () => Promise<void>;
function escaping<T>(handler: (value: T) => any | Promise<any>) : (value: T) => Promise<T | void>;
function escaping(handler: (value?: any) => any | Promise<any>) : (value?: any) => Promise<any> {
	return (value?: any) => {
		try {
			return Promise.resolve(handler(value)).catch(escape);
		} catch(e) {
			escape(e);
			return resolvedPromise;
		}
	};
}

function emptyFunction() {
}

const slice = Array.prototype.slice;

function uuid() : string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c == "x" ? r : (r & 3 | 8)).toString(16);
	});
}

// Message ordering
let outgoingMessageId = 0;
let incomingMessageId = 0;
const reorderedMessages : { [messageId: number]: ServerMessage } = {};
let willSynchronizeChannels : boolean = false;
let currentEvents: (Event | boolean)[] | undefined;
let bootstrappingChannels: number[] | undefined;
function shouldImplementLocalChannel(channelId: number) {
	return !bootstrappingChannels || (bootstrappingChannels.indexOf(channelId) != -1);
}

// Maintain whether or not inside callback
let dispatchingEvent = 1;
let dispatchingAPIImplementation: number = 0;
export let insideCallback: boolean = true;
function updateInsideCallback() {
	insideCallback = dispatchingEvent != 0 && dispatchingAPIImplementation == 0;
}
function willEnterCallback() {
	dispatchingEvent++;
	insideCallback = true;
	defer().then(didExitCallback);
}
function didExitCallback() {
	dispatchingEvent--;
	updateInsideCallback();
}

function runAPIImplementation<T>(block: () => T) : T {
	dispatchingAPIImplementation++;
	insideCallback = false;
	try {
		const result = block();
		dispatchingAPIImplementation--;
		updateInsideCallback();
		return result;
	} catch (e) {
		dispatchingAPIImplementation--;
		updateInsideCallback();
		throw e;
	}
}

// Session state
const startupScripts = document.getElementsByTagName("script");
const bootstrapData = (elements => {
	for (let i = 0; i < startupScripts.length; i++) {
		const element = startupScripts[i];
		if (element.getAttribute("type") == "application/x-mobius-bootstrap") {
			element.parentNode!.removeChild(element);
			return JSON.parse(element.textContent || element.innerHTML) as Partial<BootstrapData>;
		}
	}
	return {} as Partial<BootstrapData>;
})();
const hasBootstrap = "sessionID" in bootstrapData;
let sessionID: string | undefined = hasBootstrap ? bootstrapData.sessionID : uuid();
const clientID = (bootstrapData.clientID as number) | 0;
const serverURL = location.href.match(/^[^?]*/)![0];
let activeConnectionCount = 0;
export let dead = false;

// Remote channels
let remoteChannelCounter = 0;
const pendingChannels : { [channelId: number]: (event?: Event) => void; } = {};
let pendingChannelCount = 0;
let hadOpenServerChannel = false;

// Local channels
let localChannelCounter = 0;
let queuedLocalEvents: Event[] = [];
const fencedLocalEvents: Event[] = [];
const pendingLocalChannels: { [channelId: number]: (event: Event) => void; } = {};
let totalBatched = 0;
let isBatched: { [channelId: number]: true } = {};
let pendingBatchedActions: (() => void)[] = [];

// Heartbeat
const sessionHeartbeatInterval = 4 * 60 * 1000;
let heartbeatTimeout: number = 0;

// Websocket support
const socketURL = serverURL.replace(/^http/, "ws") + "?";
let WebSocketClass = (window as any).WebSocket as typeof WebSocket | undefined;
let websocket: WebSocket | undefined;

const afterLoaded = new Promise(resolve => {
	let eventTarget: EventTarget = window;
	for (let i = 0; i < startupScripts.length; i++) {
		const element = startupScripts[i];
		if (/\/client\.js$/.test(element.src)) {
			eventTarget = element;
			break;
		}
	}
	const onload = () => {
		resolve();
		eventTarget.removeEventListener("load", onload, false);
	};
	eventTarget.addEventListener("load", onload, false);
}).then(defer);

if (hasBootstrap) {
	++outgoingMessageId;
	const wrapperForm = document.getElementById("mobius-form") as HTMLFormElement;
	if (wrapperForm) {
		wrapperForm.onsubmit = () => false;
	}
	const events = bootstrapData.events || [];
	currentEvents = events;
	bootstrappingChannels = bootstrapData.channels;
	const firstEvent = events[0];
	if (typeof firstEvent == "boolean") {
		hadOpenServerChannel = firstEvent;
	}
	willSynchronizeChannels = true;
	// Create a hidden DOM element to render into until all events are processed
	const serverRenderedHostElement = document.body.children[0];
	serverRenderedHostElement.setAttribute("style", "pointer-events:none;user-select:none");
	const clientRenderedHostElement = document.createElement(serverRenderedHostElement.nodeName);
	clientRenderedHostElement.style.display = "none";
	document.body.insertBefore(clientRenderedHostElement, serverRenderedHostElement);
	afterLoaded.then(escaping(processMessage.bind(null, bootstrapData))).then(defer).then(() => {
		bootstrappingChannels = undefined;
		// Swap the prerendered DOM element out for the one with mounted components
		document.body.removeChild(serverRenderedHostElement);
		clientRenderedHostElement.style.display = null;
	}).then(didExitCallback).then(escaping(synchronizeChannels));
} else {
	afterLoaded.then(didExitCallback);
}

function produceMessage() : Partial<ClientMessage> {
	const result: Partial<ClientMessage> = { messageID: outgoingMessageId++ };
	if (queuedLocalEvents.length) {
		result.events = queuedLocalEvents;
		queuedLocalEvents = [];
	}
	if (clientID) {
		result.clientID = clientID;
	}
	return result;
}

function cancelHeartbeat() {
	if (heartbeatTimeout) {
		clearTimeout(heartbeatTimeout);
		heartbeatTimeout = 0;
	}
}

function restartHeartbeat() {
	cancelHeartbeat();
	heartbeatTimeout = setTimeout(sendMessages, sessionHeartbeatInterval);
}

let sendWhenDisconnected: (() => void) | undefined;
export const whenDisconnected: Promise<void> = new Promise(resolve => sendWhenDisconnected = resolve);

export function disconnect() {
	if (sessionID) {
		dead = true;
		hadOpenServerChannel = false;
		cancelHeartbeat();
		window.removeEventListener("unload", disconnect, false);
		// Forcefully tear down WebSocket
		if (websocket) {
			if (websocket.readyState < 2) {
				websocket.close();
			}
			websocket = undefined;
		}
		// Abandon pending channels
		for (let channelId in pendingChannels) {
			if (Object.hasOwnProperty.call(pendingChannels, channelId)) {
				pendingChannels[channelId]();
			}
		}
		// Send a "destroy" message so that the server can clean up the session
		const message = produceMessage();
		message.destroy = true;
		const body = serializeMessageAsQueryString(message);
		sessionID = undefined;
		if (navigator.sendBeacon) {
			navigator.sendBeacon(serverURL, body);
		} else {
			const request = new XMLHttpRequest();
			request.open("POST", serverURL, false);
			request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
			request.send(body);
		}
		// Flush fenced events
		fencedLocalEvents.reduce((promise, event) => promise.then(escaping(dispatchEvent.bind(null, event))).then(defer), resolvedPromise).then(() => {
			// Send disconnection event
			if (sendWhenDisconnected) {
				sendWhenDisconnected();
			}
		});
	}
}
window.addEventListener("unload", disconnect, false);

function dispatchEvent(event: Event) : Promise<void> | void {
	let channelId = event[0];
	let channel: ((event: Event) => void) | undefined;
	if (channelId < 0) {
		// Fenced client-side event
		for (let i = 0; i < fencedLocalEvents.length; i++) {
			const fencedEvent = fencedLocalEvents[i];
			if (fencedEvent[0] == channelId) {
				event = fencedEvent;
				fencedLocalEvents.splice(i, 1);
				break;
			}
		}
		channelId = -channelId;
		channel = pendingLocalChannels[channelId];
		// Apply batching
		if (totalBatched && isBatched[channelId] && ((--totalBatched) == 0)) {
			const batchedActions = pendingBatchedActions;
			pendingBatchedActions = [];
			isBatched = {};
			return batchedActions.reduce((promise, action) => {
				return promise.then(escaping(action)).then(defer);
			}, resolvedPromise).then(escaping(callChannelWithEvent.bind(null, channel, event)));
		}
	} else {
		// Server-side event
		channel = pendingChannels[channelId];
	}
	callChannelWithEvent(channel, event);
}

function callChannelWithEvent(channel: ((event: Event) => void) | undefined, event: Event) {
	if (channel) {
		if (totalBatched) {
			pendingBatchedActions.push(channel.bind(null, event));
		} else {
			channel(event);
		}
	}
}

function processEvents(events: (Event | boolean)[]) {
	hadOpenServerChannel = pendingChannelCount != 0;
	currentEvents = events;
	return events.reduce((promise: Promise<any>, event: Event | boolean) => {
		if (typeof event == "boolean") {
			return promise.then(() => hadOpenServerChannel = event);
		} else {
			return promise.then(escaping(dispatchEvent.bind(null, event))).then(defer);
		}
	}, resolvedPromise).then(() => {
		currentEvents = undefined;
		hadOpenServerChannel = pendingChannelCount != 0;
	});
}

function processMessage(message: ServerMessage) : Promise<void> {
	// Process messages in order
	const messageId = message.messageID;
	if (messageId > incomingMessageId) {
		// Message was received out of order, queue it for later
		reorderedMessages[messageId] = message;
		return resolvedPromise;
	}
	if (messageId < incomingMessageId) {
		return resolvedPromise;
	}
	incomingMessageId++;
	// Read each event and dispatch the appropriate event in order
	const promise = processEvents(message.events).then(() => {
		const reorderedMessage = reorderedMessages[incomingMessageId];
		if (reorderedMessage) {
			delete reorderedMessages[incomingMessageId];
			return processMessage(reorderedMessage);
		}
	});
	if (willSynchronizeChannels) {
		return promise;
	}
	willSynchronizeChannels = true;
	return promise.then(escaping(synchronizeChannels));
}

function cheesyEncodeURIComponent(text: string) {
	return encodeURIComponent(text).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",").replace(/%20/g, "+");
}

function serializeMessageAsQueryString(message: Partial<ClientMessage>) : string {
	let result = "sessionID=" + sessionID;
	if (clientID) {
		result += "&clientID=" + clientID;
	}
	if ("messageID" in message) {
		result += "&messageID=" + message.messageID;
	}
	if ("events" in message) {
		result += "&events=" + cheesyEncodeURIComponent(JSON.stringify(message.events).slice(1, -1));
	}
	if (message.destroy) {
		result += "&destroy=1";
	}
	return result;
}

function sendFormMessage(message: Partial<ClientMessage>) {
	// Form post over XMLHttpRequest is used when WebSockets are unavailable or fail
	activeConnectionCount++;
	const request = new XMLHttpRequest();
	request.open("POST", serverURL, true);
	request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
	request.onreadystatechange = () => {
		if (request.readyState == 4) {
			activeConnectionCount--;
			if (request.status == 200) {
				processMessage(deserializeMessageFromText<ServerMessage>(request.responseText, 0));
			} else {
				disconnect();
			}
		}
	}
	request.send(serializeMessageAsQueryString(message));
}

let lastWebSocketMessageId = 0;

function sendMessages(attemptWebSockets?: boolean) {
	if (!sessionID) {
		return;
	}
	if (heartbeatTimeout) {
		restartHeartbeat();
	}
	const existingSocket = websocket;
	if (existingSocket) {
		if (!queuedLocalEvents.length) {
			return;
		}
		const message = produceMessage();
		if (lastWebSocketMessageId == message.messageID) {
			delete message.messageID;
		}
		lastWebSocketMessageId = outgoingMessageId;
		if (existingSocket.readyState == 1) {
			// Send on open socket
			existingSocket.send(serializeMessageAsText(message));
		} else {
			// Coordinate with existing WebSocket that's in the process of being opened,
			// falling back to a form POST if necessary
			const existingSocketOpened = () => {
				existingSocket.removeEventListener("open", existingSocketOpened, false);
				existingSocket.removeEventListener("error", existingSocketErrored, false);
				existingSocket.send(serializeMessageAsText(message));
			}
			const existingSocketErrored = () => {
				existingSocket.removeEventListener("open", existingSocketOpened, false);
				existingSocket.removeEventListener("error", existingSocketErrored, false);
				sendFormMessage(message);
			}
			existingSocket.addEventListener("open", existingSocketOpened, false);
			existingSocket.addEventListener("error", existingSocketErrored, false);
		}
		return;
	}
	// Message will be sent in query string of new connection
	const message = produceMessage();
	lastWebSocketMessageId = outgoingMessageId;
	if (attemptWebSockets && WebSocketClass) {
		try {
			const newSocket = new WebSocketClass(socketURL + serializeMessageAsQueryString(message));
			// Attempt to open a WebSocket for channels, but not heartbeats
			const newSocketOpened = () => {
				newSocket.removeEventListener("open", newSocketOpened, false);
				newSocket.removeEventListener("error", newSocketErrored, false);
			}
			const newSocketErrored = () => {
				// WebSocket failed, fallback using form POSTs
				newSocketOpened();
				WebSocketClass = undefined;
				websocket = undefined;
				sendFormMessage(message);
			}
			newSocket.addEventListener("open", newSocketOpened, false);
			newSocket.addEventListener("error", newSocketErrored, false);
			let lastWebSocketMessageId = -1;
			newSocket.addEventListener("message", (event: any) => {
				const message = deserializeMessageFromText<ServerMessage>(event.data, lastWebSocketMessageId + 1);
				lastWebSocketMessageId = message.messageID;
				const promise = processMessage(message)
				if (message.close) {
					// Disconnect with orderly shutdown from server
					websocket = undefined;
					newSocket.close();
					if (!willSynchronizeChannels) {
						willSynchronizeChannels = true;
						promise.then(escaping(synchronizeChannels));
					}
				}
			}, false);
			websocket = newSocket;
			return;
		} catch (e) {
			WebSocketClass = undefined;
		}
	}
	// WebSockets failed fast or were unavailable
	sendFormMessage(message);
}

function synchronizeChannels() {
	willSynchronizeChannels = false;
	if (!dead) {
		const useWebSockets = pendingChannelCount != 0;
		if ((useWebSockets && activeConnectionCount == 0) || queuedLocalEvents.length) {
			sendMessages(useWebSockets);
			restartHeartbeat();
		} else if (websocket) {
			// Disconnect WebSocket when server can't possibly send us messages
			if (websocket.readyState < 2) {
				websocket.close();
			}
			websocket = undefined;
		}
	}
}

function createRawServerChannel(callback: (event?: Event) => void) : Channel {
	if (!insideCallback) {
		throw new Error("Unable to create server channel in this context!");
	}
	if (dead) {
		throw disconnectedError();
	}
	// Expect that the server will run some code in parallel that provides data
	pendingChannelCount++;
	let channelId = ++remoteChannelCounter;
	logOrdering("server", "open", channelId);
	pendingChannels[channelId] = function(event?: Event) {
		logOrdering("server", "message", channelId);
		willEnterCallback();
		callback(event);
	}
	flush();
	return {
		channelId,
		close: () => {
			// Cleanup the bookkeeping
			if (pendingChannels[channelId]) {
				logOrdering("server", "close", channelId);
				pendingChannelCount--;
				delete pendingChannels[channelId];
				channelId = -1;
			}
		}
	};
}

function sendEvent(event: Event, batched?: boolean, skipsFencing?: boolean) {
	const channelId = event[0];
	if (pendingChannelCount && !skipsFencing && !dead) {
		// Let server decide on the ordering of events since server-side channels are active
		if (batched) {
			isBatched[channelId] = true;
			++totalBatched;
		}
		event[0] = -channelId;
		fencedLocalEvents.push(event);
	} else {
		// No pending server-side channels, resolve immediately
		const eventClone = event.slice() as Event;
		eventClone[0] = -channelId;
		dispatchEvent(eventClone);
	}
	// Queue an event to be sent to the server in the next flush
	queuedLocalEvents.push(event);
	if (!batched || websocket || queuedLocalEvents.length > 9) {
		flush();
	}
}

export function flush() {
	if (!willSynchronizeChannels) {
		willSynchronizeChannels = true;
		defer().then(escaping(synchronizeChannels));
	}
}

// APIs for client/, not to be used inside src/
export const createServerPromise: <T extends JsonValue>(...args: any[]) => Promise<T> = <T extends JsonValue>() => new Promise<T>((resolve, reject) => {
	const channel = createRawServerChannel(event => {
		channel.close();
		if (event) {
			parseValueEvent(self, event, resolve as (value: JsonValue) => void, reject);
		} else {
			reject(disconnectedError());
		}
	});
});

export const synchronize = createServerPromise as () => Promise<void>;

export function createServerChannel<T extends Function>(callback: T, onAbort?: () => void): Channel {
	if (!("call" in callback)) {
		throw new TypeError("callback is not a function!");
	}
	const channel = createRawServerChannel(event => {
		if (event) {
			callback.apply(null, event.slice(1));
		} else {
			channel.close();
			if (onAbort) {
				onAbort();
			}
		}
	});
	return channel;
}


export function createClientPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T)) : Promise<T> {
	if (!insideCallback) {
		try {
			return Promise.resolve(runAPIImplementation(ask));
		} catch (e) {
			return Promise.reject(e);
		}
	}
	return new Promise<T>((resolve, reject) => {
		let channelId = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		pendingLocalChannels[channelId] = function(event: Event) {
			if (event) {
				delete pendingLocalChannels[channelId];
				willEnterCallback();
				parseValueEvent(self, event, value => {
					logOrdering("client", "message", channelId);
					logOrdering("client", "close", channelId);
					resolve(value as T);
				}, error => {
					logOrdering("client", "message", channelId);
					logOrdering("client", "close", channelId);
					reject(error);
				});
			}
		};
		if (shouldImplementLocalChannel(channelId)) {
			// Resolve value
			new Promise<T>(resolve => resolve(runAPIImplementation(ask))).then(
				escaping((value: T) => sendEvent(eventForValue(channelId, value)))
			).catch(
				escaping((error: any) => sendEvent(eventForException(channelId, error)))
			);
		}
	});
};

export function createClientChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, batched?: boolean, shouldFlushMicroTasks?: true) : Channel {
	if (!("call" in callback)) {
		throw new TypeError("callback is not a function!");
	}
	let state: U | undefined;
	if (!insideCallback) {
		let open = true;
		try {
			const potentialState = runAPIImplementation(() => onOpen(function() {
				if (open) {
					callback.apply(null, slice.call(arguments));
				}
			} as any as T));
			if (onClose) {
				state = potentialState;
			}
		} catch (e) {
			onClose = undefined;
			escape(e);
		}
		return {
			channelId: -1,
			close() {
				if (open) {
					open = false;
					try {
						runAPIImplementation(() => onClose && onClose(state as U));
					} catch (e) {
						escape(e);
					}
				}
			}
		};
	}
	let channelId: number = ++localChannelCounter;
	pendingLocalChannels[channelId] = function(event: Event) {
		if (channelId >= 0) {
			logOrdering("client", "message", channelId);
			willEnterCallback();
			callback.apply(null, event.slice(1));
			if (shouldFlushMicroTasks) {
				flushMicroTasks();
			}
		}
	};
	try {
		if (shouldImplementLocalChannel(channelId)) {
			const potentialState = runAPIImplementation(() => onOpen(function() {
				if (channelId >= 0) {
					const message = roundTrip(slice.call(arguments));
					message.unshift(channelId);
					resolvedPromise.then(escaping(sendEvent.bind(null, message, batched)));
				}
			} as any as T));
			if (onClose) {
				state = potentialState;
			}
		} else {
			onClose = undefined;
		}
	} catch (e) {
		onClose = undefined;
		escape(e);
	}
	logOrdering("client", "open", channelId);
	return {
		channelId,
		close() {
			if (channelId >= 0) {
				delete pendingLocalChannels[channelId];
				logOrdering("client", "close", channelId);
				channelId = -1;
				try {
					runAPIImplementation(() => onClose && onClose(state as U));
				} catch (e) {
					escape(e);
				}
			}
		}
	};
}

export function coordinateValue<T extends JsonValue>(generator: () => T) : T {
	if (!dispatchingEvent) {
		return generator();
	}
	let value: T;
	let events = currentEvents;
	if (hadOpenServerChannel) {
		let channelId = ++remoteChannelCounter;
		logOrdering("server", "open", channelId);
		// Peek at incoming events to find the value generated on the server
		if (events) {
			for (var i = 0; i < events.length; i++) {
				var event = events[i] as Event;
				if (event[0] == channelId) {
					pendingChannels[channelId] = emptyFunction;
					return parseValueEvent(self, event, value => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						return value;
					}, error => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						throw error
					}) as T;
				}
			}
		}
		console.log("Expected a value from the server, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
		value = generator();
		logOrdering("server", "message", channelId);
		logOrdering("server", "close", channelId);
	} else {
		let channelId = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		if (events) {
			for (var i = 0; i < events.length; i++) {
				var event = events[i] as Event;
				if (event[0] == -channelId) {
					pendingLocalChannels[channelId] = emptyFunction;
					return parseValueEvent(self, event, value => {
						logOrdering("client", "message", channelId);
						logOrdering("client", "close", channelId);
						return value;
					}, error => {
						logOrdering("client", "message", channelId);
						logOrdering("client", "close", channelId);
						throw error
					}) as T;
				}
			}
		}
		try {
			value = generator();
			const event = eventForValue(channelId, value);
			try {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				sendEvent(event, true, true);
			} catch(e) {
				escape(e);
			}
		} catch(e) {
			try {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				sendEvent(eventForException(channelId, e), true, true);
			} catch(e) {
				escape(e);
			}
			throw e;
		}
	}
	return roundTrip(value);
}

export function shareSession() : Promise<string> {
	return createServerPromise<string>().then(value => {
		// Dummy channel that stays open
		createServerChannel(emptyFunction);
		return value;
	});
}

function bundledPromiseImplementation() {
	// Promise implementation that properly schedules as a micro-task

	const enum PromiseState {
		Pending = 0,
		Fulfilled = 1,
		Rejected = 2,
	};

	function settlePromise<T>(this: Promise<T>, state: PromiseState, value: any) {
		if (!this.__state) {
			if (value instanceof Promise) {
				if (value.__state) {
					state = value.__state;
					value = value.__value;
				} else {
					(value.__observers || (value.__observers = [])).push(settlePromise.bind(this, PromiseState.Fulfilled, value));
					return;
				}
			} else if (isPromiseLike(value)) {
				const recover = settlePromise.bind(this, PromiseState.Fulfilled);
				value.then(recover, recover);
				return;
			}
			this.__state = state;
			this.__value = value;
			const observers = this.__observers;
			if (observers) {
				this.__observers = undefined;
				for (let i = 0; i < observers.length; i++) {
					submitTask(microTaskQueue, observers[i]);
				}
			}
		}
	}

	class Promise <T> {
		__state: PromiseState;
		__value: any;
		__observers?: Task[];
		constructor(executor?: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) {
			if (executor) {
				const reject = settlePromise.bind(this, PromiseState.Rejected);
				try {
					executor(settlePromise.bind(this, PromiseState.Fulfilled), reject);
				} catch (e) {
					this.__state = PromiseState.Rejected;
					this.__value = e;
				}
			}
		}
		then<TResult1 = T, TResult2 = never>(onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
			return new Promise<TResult1 | TResult2>((resolve, reject) => {
				const completed = () => {
					try {
						const value = this.__value;
						if (this.__state == PromiseState.Fulfilled) {
							resolve(onFulfilled ? onFulfilled(value) : value);
						} else if (onRejected) {
							resolve(onRejected(value));
						} else {
							reject(value);
						}
					} catch (e) {
						reject(e);
					}
				}
				if (this.__state) {
					submitTask(microTaskQueue, completed);
				} else {
					(this.__observers || (this.__observers = [])).push(completed);
				}
			});
		}
		catch<TResult = never>(onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
			return this.then(undefined, onRejected);
		}
		static resolve<T>(value: Promise<T> | T) : Promise<T>;
	    static resolve(): Promise<void>;
		static resolve<T>(value?: Promise<T> | T) : Promise<T> {
			if (isPromiseLike(value)) {
				return new Promise<T>((resolve, reject) => value.then(resolve, reject));
			}
			const result = new Promise<T>();
			result.__value = value;
			result.__state = PromiseState.Fulfilled;
			return result;
		}
		static reject<T = never>(reason: any) : Promise<T> {
			const result = new Promise<T>();
			result.__value = reason;
			result.__state = PromiseState.Rejected;
			return result;
		}
		static race<T>(values: ReadonlyArray<Promise<T> | T>) : Promise<T> {
			for (let i = 0; i < values.length; i++) {
				const value = values[i];
				if (!isPromiseLike(value)) {
					const result = new Promise<T>();
					result.__value = value;
					result.__state = PromiseState.Fulfilled;
					return result;
				} else if (value instanceof Promise && value.__state) {
					const result = new Promise<T>();
					result.__value = value.__value;
					result.__state = value.__state;
					return result;
				}
			}
			return new Promise<T>((resolve, reject) => {
				for (let i = 0; i < values.length; i++) {
					(values[i] as Promise<T>).then(resolve, reject);
				}
			});
		}
		static all<T>(values: ReadonlyArray<Promise<T> | T>) : Promise<T[]> {
			let remaining = values.length;
			const result = new Array(remaining);
			return new Promise<T[]>((resolve, reject) => {
				for (let i = 0; i < values.length; i++) {
					const value = values[i];
					if (isPromiseLike(value)) {
						value.then(value => {
							result[i] = value;
							if ((--remaining) == 0) {
								resolve(result);
							}
						}, reject);
					} else {
						result[i] = value;
						if ((--remaining) == 0) {
							resolve(result);
						}
					}
				}
			});
		}
	};

	return Promise;
}

interceptGlobals(window, () => insideCallback && !dead, coordinateValue, <T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean) => {
	let recovered: (() => void) | undefined;
	const channel = createServerChannel(callback, () => {
		const state = onOpen(callback);
		recovered = () => {
			if (onClose) {
				onClose(state);
			}
		}
	});
	return {
		close: () => {
			if (recovered) {
				recovered();
			} else {
				channel.close();
			}
		}
	}
});
