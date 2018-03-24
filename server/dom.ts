import * as _dom from "_dom";
import _domValidators from "_dom!validators";
import { restoreDefaults } from "_internal";
import { createClientChannel } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, Component, ComponentFactory, ComponentProps, FunctionalComponent } from "preact";

type PreactNode = Element & {
	_listeners?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [Channel, (event: any) => void] },
};

const preactOptions = preact.options as any;
preactOptions.keyAttribute = "data-key";
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
		ignore_nondeterminism:
		for (const name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][0].close();
				delete c[name];
			}
		}
	}
};

function ignoreEvent() {
	/* tslint:disable no-empty */
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
					tuple[1](restoreDefaults(event, _dom.defaultEventProperties));
				}, _domValidators.EventArgs);
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
				node.setAttribute(`on${name}`, `_dispatch(${channel.channelId},event)`);
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
			node.removeAttribute(`on${name}`);
			channel.close();
			delete c[name];
		}
	}
};

export function host(content: JSX.Element): void {
	const element = (require("body") as HTMLBodyElement).children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string): void {
	const head = require("head") as HTMLHeadElement;
	let element = head.querySelector("title");
	if (!element) {
		element = (require("document") as Document).createElement("title");
		head.appendChild(element);
	}
	element.textContent = newTitle;
}
