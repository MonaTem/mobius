/// <reference types="preact" />

namespace concurrence {
	export function render(contents: JSX.Element, selector?: string) : void {
		const d = document;
		if (d) {
			const element = selector ? d.querySelector(selector) : d.body;
			if (element) {
				try {
					const children = element.children;
					preact.render(contents, element, children[children.length - 1]);
				} catch (e) {
					console.error("Error during Preact DOM rendering:", e);
				}
			} else {
				console.error(new Error("Selector not found: " + selector));
			}
		}
	}
	export function read(selector: string) : Promise<string> {
		return concurrence.createRenderPromise<string>((document, resolve, reject) => {
			const element = document.querySelector(selector);
			if (element && "value" in element) {
				resolve((element as any).value);
			} else {
				reject(new Error("Selector not found, or not an element with value: " + selector));
			}
		});
	}
}
