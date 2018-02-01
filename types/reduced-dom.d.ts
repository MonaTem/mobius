// DOM types necessary to integrate with the server-side DOM implementation,
// but as few as possible since it's an implementation detail and not exposed to user code

interface DOMException {
	readonly code: number;
	readonly message: string;
	readonly name: string;
	toString(): string;
}

declare var DOMException: {
	prototype: DOMException;
	new(message?: string, name?: string): DOMException;
}

interface DOMImplementation {
}

declare var DOMImplementation: {
    prototype: DOMImplementation;
    new(): DOMImplementation;
};

interface EventTarget {
}

interface Event {
}

interface Window {
	readonly document: Document;
}

interface Node extends EventTarget {
	readonly nodeName: string;
	readonly firstChild: Node | null;
	readonly parentNode: Node | null;
	readonly parentElement: HTMLElement | null;
	appendChild<T extends Node>(newChild: T): T;
	insertBefore<T extends Node>(newChild: T, refChild: Node | null): T;
	replaceChild<T extends Node>(newChild: Node, oldChild: T): T;
	removeChild<T extends Node>(oldChild: T): T;
	cloneNode(deep?: boolean): Node;
	textContent: string;
}

interface NodeList {
    readonly length: number;
    item(index: number): Node;
    [index: number]: Node;
}

declare var NodeList: {
    prototype: NodeList;
    new(): NodeList;
};

declare var Node: {
	prototype: Node;
	new(): Node;
	readonly ATTRIBUTE_NODE: number;
	readonly CDATA_SECTION_NODE: number;
	readonly COMMENT_NODE: number;
	readonly DOCUMENT_FRAGMENT_NODE: number;
	readonly DOCUMENT_NODE: number;
	readonly DOCUMENT_POSITION_CONTAINED_BY: number;
	readonly DOCUMENT_POSITION_CONTAINS: number;
	readonly DOCUMENT_POSITION_DISCONNECTED: number;
	readonly DOCUMENT_POSITION_FOLLOWING: number;
	readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: number;
	readonly DOCUMENT_POSITION_PRECEDING: number;
	readonly DOCUMENT_TYPE_NODE: number;
	readonly ELEMENT_NODE: number;
	readonly ENTITY_NODE: number;
	readonly ENTITY_REFERENCE_NODE: number;
	readonly NOTATION_NODE: number;
	readonly PROCESSING_INSTRUCTION_NODE: number;
	readonly TEXT_NODE: number;
};

interface Attr extends Node {
	readonly name: string;
	readonly ownerElement: Element;
	readonly prefix: string | null;
	readonly specified: boolean;
	value: string;
}

declare var Attr: {
	prototype: Attr;
	new(): Attr;
};

interface CharacterData extends Node {
	data: string;
}

declare var CharacterData: {
	prototype: CharacterData;
	new(): CharacterData;
};

interface Text extends CharacterData {
}

declare var Text: {
	prototype: Text;
	new(): Text;
};

interface Comment extends CharacterData {
	text: string;
}

declare var Comment: {
	prototype: Comment;
	new(): Comment;
};

interface ProcessingInstruction extends CharacterData {
	readonly target: string;
}

declare var ProcessingInstruction: {
	prototype: ProcessingInstruction;
	new(): ProcessingInstruction;
};

interface CDATASection extends Text {
}

declare var CDATASection: {
	prototype: CDATASection;
	new(): CDATASection;
};

interface DocumentType extends Node {
	readonly name: string;
}

declare var DocumentType: {
	prototype: DocumentType;
	new(): DocumentType;
};

interface Document extends Node {
	createElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
	createElement(tagName: string): HTMLElement;
	createTextNode(data: string): Text;
	querySelector(selectors: string): Element | null;
	querySelectorAll<K extends keyof HTMLElementTagNameMap>(knownSelectors: K): ArrayLike<HTMLElementTagNameMap[K]>;
	querySelectorAll(selectors: string): ArrayLike<HTMLElement>;
	getElementsByTagName<K extends keyof HTMLElementTagNameMap>(tagName: K): ArrayLike<HTMLElementTagNameMap[K]>;
	getElementsByTagName(tagName: string): ArrayLike<HTMLElement>;
	readonly body: HTMLBodyElement;
	readonly head: HTMLHeadElement;
}

declare var Document: {
	prototype: Document;
	new(): Document;
};

interface HTMLDocument extends Document {
}

declare var HTMLDocument: {
	prototype: HTMLDocument;
	new(): HTMLDocument;
};

interface XMLDocument extends Document {
}

declare var XMLDocument: {
	prototype: XMLDocument;
	new(): XMLDocument;
};

interface DocumentFragment extends Node {
}

declare var DocumentFragment: {
	prototype: DocumentFragment;
	new(): DocumentFragment;
};

interface Element extends Node {
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	removeAttribute(name: string): void;
	querySelector(selectors: string): Element | null;
	getElementsByTagName<K extends keyof HTMLElementTagNameMap>(tagName: K): ArrayLike<HTMLElementTagNameMap[K]>;
	getElementsByTagName(tagName: string): ArrayLike<Element>;
	children: ArrayLike<Element>;
	lastElementChild: Element | null;
	previousElementSibling: Element | null;
	innerText: string;
}

declare var Element: {
	prototype: Element;
	new(): Element;
};

interface HTMLCollection {
    readonly length: number;
    item(index: number): Element;
    [index: number]: Element;
    namedItem(name: string): Element | null;
}

declare var HTMLCollection: {
    prototype: HTMLCollection;
    new(): HTMLCollection;
};

interface HTMLElement extends Element {
}

interface HTMLBodyElement extends Element {
}

interface HTMLHeadElement extends Element {
}

interface HTMLFormElement extends HTMLElement {
}

interface HTMLInputElement extends HTMLElement {
	value: string;
}

interface HTMLScriptElement extends HTMLElement {
	src: string;
	type: string;
}

interface HTMLLinkElement extends HTMLElement {
	href: string;
	rel: string;
}

interface HTMLStyleElement extends HTMLElement {
	href: string;
}

interface HTMLElementTagNameMap {
	"body": HTMLBodyElement;
	"form": HTMLFormElement;
	"head": HTMLHeadElement;
	"input": HTMLInputElement;
	"script": HTMLScriptElement;
	"style": HTMLStyleElement;
	"link": HTMLLinkElement;
}
