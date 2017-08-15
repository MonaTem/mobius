/// <reference types="preact" />

namespace concurrence {
	export function render(contents: JSX.Element, selector?: string) : void {
		const document = (self as any).document as Document;
		const element = typeof selector == "string" ? document.querySelector(selector) : document.body;
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
