import { createClientChannel, createClientPromise } from "mobius";
import { Channel } from "mobius-types";
import { defaultEventProperties } from "_dom";
import { stripDefaults, restoreDefaults } from "_internal";
import * as preact from "preact";
export { h, Component, AnyComponent, ComponentProps } from "preact";

type PreactNode = Element & {
	__l?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [Channel, (event: any) => void] }
};

const preactOptions = preact.options as any;
preactOptions.keyAttribute = "data-key";
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
		ignore_nondeterminism:
		for (let name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][0].close();
				delete c[name];
			}
		}
	}
}

function ignoreEvent() {
}

preactOptions.listenerUpdated = (node: PreactNode, name: string) => {
	const listeners = node._listeners;
	if (listeners) {
		const c = node.__c || (node.__c = {});
		if (Object.hasOwnProperty.call(listeners, name)) {
			const listener = listeners[name];
			let tuple = c[name];
			if (tuple) {
				tuple[1] = listener;
			} else {
				const channel = createClientChannel((event: any) => {
					tuple[1](restoreDefaults(event, defaultEventProperties));
				});
				if (node.nodeName == "INPUT" || node.nodeName == "TEXTAREA") {
					switch (name) {
						case "keydown":
						case "keyup":
						case "input":
						case "change":
							node.setAttribute("name", `channelID${channel.channelId}`);
							break;
					}
				} else {
					switch (name) {
						case "click":
							node.setAttribute("name", `channelID${channel.channelId}`);
							break;
					}
				}
				node.setAttribute(`data-mobius-on${name}`, channel.channelId.toString());
				tuple = c[name] = [channel, listener];
			}
			listeners[name] = ignoreEvent;
		} else if (Object.hasOwnProperty.call(c, name)) {
			const channel = c[name][0];
			if (node.getAttribute("name") == `channelID${channel.channelId}`) {
				// Only remove click channels for now, because input-related channels are merged
				if (name == "click") {
					node.removeAttribute("name");
				}
			}
			node.removeAttribute(`data-mobius-on${name}`);
			channel.close();
			delete c[name];
		}
	}
}

export function host(content: JSX.Element) : void {
	const element = (require("body") as HTMLBodyElement).children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string) : void {
	const head = (require("head") as HTMLHeadElement);
	let element = head.querySelector("title");
	if (!element) {
		element = self.document.createElement("title");
		head.appendChild(element);
	}
	element.innerText = newTitle;
}

const requestedStyles: { [href: string]: Promise<void> } = {};

export function style(href: string, subresourceIntegrity?: string) : Promise<void> {
	let result = requestedStyles[href];
	if (!result) {
		const link = self.document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		if (subresourceIntegrity) {
			link.setAttribute("integrity", subresourceIntegrity);
		}
		(require("head") as HTMLHeadElement).appendChild(link);
		result = requestedStyles[href] = createClientPromise(() => {
			// Fallback is to return immediately--if unable to track client's ability to load CSS, just proceed
		});
	}
	return result;
}
