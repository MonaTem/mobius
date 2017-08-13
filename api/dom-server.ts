/// <reference types="preact" />

namespace concurrence {

	type PreactNode = Node & {
		__l?: { [ event: string ]: () => void },
		__c?: { [ event: string ]: ConcurrenceChannel }
	};

	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceChannel {
		return concurrence.receiveClientEventStream(callback);
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

	function ignoreEvent() {
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
				const channel = concurrence.receiveClientEventStream(listeners[name]);
				listeners[name] = ignoreEvent;
				c[name] = channel;
			}
		}
	}

}
