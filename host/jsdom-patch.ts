let patchedJSDOM = false;
export default function(document: Document) {
	// Make input.value = ... update the DOM attribute
	if (!patchedJSDOM) {
		patchedJSDOM = true;
		const HTMLInputElementPrototype = document.createElement("input").constructor.prototype;
		const oldDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElementPrototype, "value");
		if (oldDescriptor) {
			const descriptor = Object.create(oldDescriptor);
			const oldSet = descriptor.set;
			descriptor.set = function(value: string) {
				oldSet.call(this, value);
				this.setAttribute("value", value);
			};
			Object.defineProperty(HTMLInputElementPrototype, "value", descriptor);
		}
	}
}
