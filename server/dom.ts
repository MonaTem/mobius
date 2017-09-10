import { createClientChannel } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, cloneElement, Component, AnyComponent, ComponentProps } from "preact";

type PreactNode = Element & {
	__l?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [Channel, (event: any) => void] }
};

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
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
	const listeners = node.__l;
	if (listeners) {
		const c = node.__c || (node.__c = {});
		if (Object.hasOwnProperty.call(listeners, name)) {
			const listener = listeners[name];
			let tuple = c[name];
			if (tuple) {
				tuple[1] = listener;
			} else {
				const channel = createClientChannel(function() {
					return tuple[1].apply(null, arguments);
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
				node.setAttribute(`data-mobius-on${name}`, `channelID${channel.channelId}`);
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
	const element = self.document.body.children[0];
	preact.render(content, element, element.children[0]);
}
