import { Session } from "./session";
import { defer } from "./event-loop";
import { Event, ServerMessage, ClientMessage } from "../common/_internal";

import { Request, Response } from "express";

export class Client {
	session: Session;
	request: Request;
	clientID: number;
	incomingMessageId: number = 0;
	outgoingMessageId: number = 0;
	reorderedMessages: { [messageId: number]: ClientMessage } = {};
	queuedLocalEvents: Event[] | undefined;
	queuedLocalEventsResolve: ((shouldContinue: true | void) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	willSynchronizeChannels = false;
	lastSentFormHTML?: string;
	pendingCookies?: [string, string][];
	clientIsActive?: true;

	constructor(session: Session, request: Request, clientID: number) {
		this.session = session;
		this.request = request;
		this.clientID = clientID;
	}

	async destroy() {
		this.session.clients.delete(this.clientID);
		if (this.queuedLocalEventsResolve) {
			this.queuedLocalEventsResolve(undefined);
		}
		this.synchronizeChannels();
		// Destroy the session if we were the last client
		if (this.session.clients.size == 0) {
			await this.session.destroy();
		}
	}

	async processMessage(message: ClientMessage) : Promise<void> {
		// Process messages in order
		const messageId = message.messageID;
		if (messageId > this.incomingMessageId) {
			// Message was received out of order, queue it for later
			this.reorderedMessages[messageId] = message;
			return;
		}
		if (messageId < this.incomingMessageId) {
			return;
		}
		this.incomingMessageId++;
		this.willSynchronizeChannels = true;
		await this.session.processEvents(message.events || [], message.noJavaScript);
		const reorderedMessage = this.reorderedMessages[this.incomingMessageId];
		if (reorderedMessage) {
			delete this.reorderedMessages[this.incomingMessageId];
			await this.processMessage(reorderedMessage);
		}
		this.synchronizeChannels();
		// Destroy if asked to by client
		if (message.destroy) {
			await this.destroy();
		}
	}

	receiveMessage(message: ClientMessage) : Promise<void> {
		this.session.lastMessageTime = Date.now();
		return this.processMessage(message);
	}

	async receiveFallbackMessage(message: ClientMessage, body: { [key: string]: string}) : Promise<void> {
		// JavaScript is disabled, emulate events from form POST
		const inputEvents: Event[] = [];
		const buttonEvents: Event[] = [];
		message.noJavaScript = true;
		for (let key in body) {
			if (!Object.hasOwnProperty.call(body, key)) {
				continue;
			}
			const match = key.match(/^channelID(\d+)$/);
			if (match && Object.hasOwnProperty.call(body, key)) {
				const value = await this.session.valueForFormField(key);
				if (value === undefined || value !== body[key]) {
					const event: Event = [-match[1], { value: body[key] }];
					inputEvents.unshift(event);
				}
			}
		}
		message.events = message.events.concat(inputEvents.concat(buttonEvents));
		return await this.receiveMessage(message);
	}

	produceMessage(close: boolean) : Partial<ServerMessage> {
		const result: Partial<ServerMessage> = { messageID: this.outgoingMessageId++ };
		if (close) {
			result.close = true;
		}
		if (this.queuedLocalEvents) {
			result.events = this.queuedLocalEvents;
			this.queuedLocalEvents = undefined;
		}
		return result;
	}

	async dequeueEvents() : Promise<true | void> {
		return new Promise<true | void>((resolve, reject) => {
			// Wait until events are ready, a new event handler comes in, or no more local channels exist
			const oldResolve = this.queuedLocalEventsResolve;
			if (this.queuedLocalEvents) {
				if (oldResolve) {
					this.queuedLocalEventsResolve = resolve;
					oldResolve(true);
				} else {
					resolve(true);
					return;
				}
			} else if (this.session.hasLocalChannels()) {
				this.queuedLocalEventsResolve = resolve;
				if (oldResolve) {
					oldResolve(undefined);
				}
			} else {
				resolve(undefined);
				return;
			}
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
			}
			this.localResolveTimeout = setTimeout(resolve, 30000);
		});
	}

	sendEvent(event: Event) {
		// Queue an event
		const queuedLocalEvents = this.queuedLocalEvents;
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			this.queuedLocalEvents = [event];
		}
		this.scheduleSynchronize();
	}

	synchronizeChannels = () => {
		this.willSynchronizeChannels = false;
		const resolve = this.queuedLocalEventsResolve;
		if (resolve) {
			this.queuedLocalEventsResolve = undefined;
			resolve(true);
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
				this.localResolveTimeout = undefined;
			}
		}
		return this.session.destroyIfExhausted();
	}

	scheduleSynchronize() {
		if (!this.willSynchronizeChannels) {
			this.willSynchronizeChannels = true;
			defer().then(this.synchronizeChannels);
		}
	}

	setCookie(key: string, value: string) {
		const cookies = this.pendingCookies || (this.pendingCookies = []);
		cookies.push([key, value]);
	}
	applyCookies(response: Response) {
		const cookies = this.pendingCookies;
		if (cookies) {
			this.pendingCookies = undefined;
			for (let [ key, value ] of cookies) {
				response.cookie(key, value);
			}
		}
	}
}
