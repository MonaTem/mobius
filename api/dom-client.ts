/// <reference types="preact" />

namespace concurrence {

	type PreactNode = Node & {
		__l?: { [ event: string ]: (event: any) => void },
		__c?: { [ event: string ]: ConcurrenceChannel }
	};

	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceChannel {
		const transaction = concurrence.observeClientEventCallback(callback);
		const elements = document.querySelectorAll(selector);
		for (let i = 0; i < elements.length; i++) {
			elements[i].addEventListener(event, () => transaction.send(), false);
		}
		return transaction;
	}

	const preactOptions = preact.options as any;
	preactOptions.nodeRemoved = (node: PreactNode) => {
		const c = node.__c;
		if (c) {
			for (let name in c) {
				if (Object.hasOwnProperty.call(c, name)) {
					c[name].close();
					delete c[name];
				}
			}
		}
	}

	preactOptions.listenerUpdated = (node: PreactNode, name: string) => {
		const listeners = node.__l;
		if (listeners) {
			const c = node.__c || (node.__c = {});
			if (Object.hasOwnProperty.call(c, name)) {
				c[name].close();
				delete c[name];
			}
			if (Object.hasOwnProperty.call(listeners, name)) {
				const channel = concurrence.observeClientEventCallback(listeners[name]);
				listeners[name] = (event) => {
					if ("value" in event.target) {
						channel.send({ value: event.target.value });
					} else {
						channel.send({});
					}
				}
				c[name] = channel;
			}
		}
	}

}
