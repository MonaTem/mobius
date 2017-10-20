// DOM types necessary to integrate with the server-side DOM implementation,
// but as few as possible since it's an implementation detail and not exposed to user code

interface EventTarget {
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

interface CharacterData extends Node {
	data: string;
}

interface Text extends CharacterData {
}

interface Document extends Node {
	createElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
	createElement(tagName: string): HTMLElement;
	createTextNode(data: string): Text;
	querySelector(selectors: string): Element | null;
	readonly body: HTMLBodyElement;
	readonly head: HTMLHeadElement;
}

interface DocumentFragment extends Node {
}

interface Element extends Node {
	setAttribute(name: string, value: string): void;
	querySelector(selectors: string): Element | null;
}

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

interface HTMLElementTagNameMap {
	"body": HTMLBodyElement;
	"form": HTMLFormElement;
	"head": HTMLHeadElement;
	"input": HTMLInputElement;
	"script": HTMLScriptElement;
}
