/// <reference types="preact" />

namespace concurrence {

	type PreactNode = Node & {
		__l?: { [ event: string ]: (event: any) => void },
		__c?: { [ event: string ]: [ConcurrenceChannel, (event: any) => void] }
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
					tuple = c[name] = [concurrence.receiveClientEventStream(function() {
						return tuple[1].apply(null, [].slice.call(arguments));
					}), listener];
				}
				listeners[name] = ignoreEvent;
			} else if (Object.hasOwnProperty.call(c, name)) {
				c[name][0].close();
				delete c[name];
			}
		}
	}

}
