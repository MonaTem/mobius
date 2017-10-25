import { escape } from "./event-loop";
import { exists } from "./fileUtils";
import { createSessionGroup, Session } from "./session";
import { archivePathForSessionId, HostSandboxOptions } from "./session-sandbox";

import { ClientMessage } from "../common/_internal";

import { JsonValue } from "mobius-types";

import { Request } from "express";

import * as uuid from "uuid/v4";

export class Host {
	public sessions = new Map<string, Session>();
	public destroying: boolean = false;
	public options: HostSandboxOptions;
	public staleSessionTimeout: any;
	public constructSession: (sessionID: string, request?: Request) => Session;
	constructor(scriptPath: string, serverModulePaths: string[], modulePaths: string[], sessionsPath: string, publicPath: string, htmlSource: string, secrets: JsonValue, allowMultipleClientsPerSession: boolean, workerCount: number, hostname?: string) {
		this.destroying = false;
		this.constructSession = createSessionGroup(this.options = {
			htmlSource,
			allowMultipleClientsPerSession,
			secrets,
			serverModulePaths,
			modulePaths,
			scriptPath,
			publicPath,
			sessionsPath,
			hostname,
		}, this.sessions, workerCount);
		// Session timeout
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (const session of this.sessions.values()) {
				if (now - session.lastMessageTime > 5 * 60 * 1000) {
					session.destroy().catch(escape);
				} else {
					session.archiveEvents(false).catch(escape);
				}
			}
		}, 10 * 1000);
	}
	public async sessionFromId(sessionID: string | undefined, request: Request, allowNewSession: boolean) {
		if (!sessionID) {
			throw new Error("No session ID specified!");
		}
		let session = this.sessions.get(sessionID);
		if (session) {
			return session;
		}
		if (!this.destroying) {
			if (this.options.allowMultipleClientsPerSession) {
				session = this.constructSession(sessionID, request);
				this.sessions.set(sessionID, session);
				try {
					await session.unarchiveEvents();
				} catch (e) {
					if (allowNewSession) {
						session.client.newClient(session, request);
					} else {
						throw e;
					}
				}
				return session;
			}
			if (allowNewSession) {
				session = this.constructSession(sessionID, request);
				session.client.newClient(session, request);
				this.sessions.set(sessionID, session);
				return session;
			}
		}
		throw new Error("Session ID is not valid: " + sessionID);
	}
	public async clientFromMessage(message: ClientMessage, request: Request, allowNewSession: boolean) {
		const clientID = message.clientID as number | 0;
		const session = await this.sessionFromId(message.sessionID, request, allowNewSession && message.messageID == 0 && clientID == 0);
		const client = session.client.get(clientID);
		if (!client) {
			throw new Error("Client ID is not valid: " + message.clientID);
		}
		client.request = request;
		return client;
	}
	public async newClient(request: Request) {
		if (this.destroying) {
			throw new Error("Cannot create new client while shutting down!");
		}
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions.has(sessionID) && (!this.options.allowMultipleClientsPerSession || !await exists(archivePathForSessionId(this.options.sessionsPath, sessionID)))) {
				const session = this.constructSession(sessionID, request);
				this.sessions.set(sessionID, session);
				return session.client.newClient(session, request);
			}
		}
	}
	public async destroyClientById(sessionID: string, clientID: number) {
		const session = this.sessions.get(sessionID);
		if (session) {
			const client = session.client.get(clientID);
			if (client) {
				await client.destroy();
			}
		}
	}
	public async destroy() {
		this.destroying = true;
		clearInterval(this.staleSessionTimeout);
		const promises: Array<Promise<void>> = [];
		for (const session of this.sessions.values()) {
			promises.push(session.destroy());
		}
		await Promise.all(promises);
	}
}
