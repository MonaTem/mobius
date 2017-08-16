class ShowHideWidget extends preact.Component<{}, { visible: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { visible: false };
	}
	render(props: preact.ComponentProps<this>) {
		if (this.state.visible) {
			return <div><button onClick={this.hide}>Hide</button><div>{props.children}</div></div>
		} else {
			return <div><button onClick={this.show}>Show</button></div>
		}
	}
	show = () => this.setState({ visible: true })
	hide = () => this.setState({ visible: false })
}


class RandomWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Generating random numbers");
		this.state = { value: "" };
		this.updateRandom();
	}
	updateRandom = () => {
		concurrence.random().then(value => {
			console.log(value);
			this.setState({ value: value.toString() });
		});
	}
	randomChannel: ConcurrenceChannel = concurrence.interval(this.updateRandom, 1000);
	render() {
		return <span>So random: {this.state.value}</span>;
	}
	componentWillUnmount() {
		console.log("Destroying random stream");
		this.randomChannel.close();
	}
}


class TextField extends preact.Component<{ value: string, onChange: (value: string) => void }, { value: string }> {
	onChange = (event: any) => {
		this.props.onChange(event.value as string);
	}
	render() {
		return <input value={this.props.value} onChange={this.onChange} onKeyUp={this.onChange}/>
	}
}


class ReceiveWidget extends preact.Component<{}, { messages: string[] }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Receiving messages");
		this.state = { messages: [] };
	}
	receiveChannel: ConcurrenceChannel = concurrence.receive("messages", value => {
		console.log("Received: " + value);
		this.setState({ messages: [value as string].concat(this.state.messages) });
	});
	render() {
		const messages = this.state.messages;
		return <span>{messages.length > 0 ? messages.map(message => <div>{message}</div>) : "No Messages"}</span>;
	}
	componentWillUnmount() {
		console.log("Destroying message stream");
		this.receiveChannel.close();
	}
}

class BroadcastWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField value={this.state.value} onChange={this.updateValue}/>
				<button onClick={this.send}>Send</button>
			</div>
		);
	}
	updateValue = (value: string) => this.setState({ value })
	send = () => {
		concurrence.broadcast("messages", this.state.value);
	}
}

type ItemRecord = { id: number, text: string };
type ItemOperation = ConcurrenceJsonMap & {
	operation: "create" | "modify" | "delete";
	record: ItemRecord;
};

class NewItemWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField value={this.state.value} onChange={this.onChange} />
				<button onClick={this.send}>Add</button>
			</div>
		);
	}
	onChange = (value: string) => this.setState({ value })
	send = () => {
		concurrence.mysql.modify("localhost", "INSERT INTO concurrence_todo.items (text) VALUES (?)", this.state.value).then(result => {
			const message: ItemOperation = {
				operation: "create",
				record: { id: result.insertId as number, text: this.state.value }
			};
			concurrence.broadcast("item-changes", message);
			this.setState({ value: "" });
		}).catch(e => console.log(e));
	}
}

class ItemWidget extends preact.Component<{ item: ItemRecord }, { pendingText: string | undefined, inProgress: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { pendingText: undefined, inProgress: false };
	}
	render() {
		return (
			<div>
				<TextField value={typeof this.state.pendingText != "undefined" ? this.state.pendingText : this.props.item.text} onChange={this.setPendingText}/>
				<button onClick={this.delete} disabled={this.state.inProgress}>Delete</button>
				{typeof this.state.pendingText != "undefined" ? <button onClick={this.save} disabled={this.state.inProgress}>Save</button> : null}
			</div>
		);
	}
	setPendingText = (pendingText: string) => this.setState({ pendingText })
	save = () => {
		if (typeof this.state.pendingText != "undefined") {
			const message: ItemOperation = {
				operation: "modify",
				record: { id: this.props.item.id, text: this.state.pendingText }
			};
			this.setState({ inProgress: true });
			concurrence.mysql.modify("localhost", "UPDATE concurrence_todo.items SET text = ? WHERE id = ?", this.state.pendingText, this.props.item.id).then(result => {
				concurrence.broadcast("item-changes", message);
				this.setState({ pendingText: undefined, inProgress: false });
			}).catch(e => console.log(e));
		}
	}
	delete = () => {
		this.setState({ inProgress: true });
		const message: ItemOperation = {
			operation: "delete",
			record: this.props.item
		};
		concurrence.mysql.modify("localhost", "DELETE FROM concurrence_todo.items WHERE id = ?", this.props.item.id).then(result => {
			concurrence.broadcast("item-changes", message);
			this.setState({ inProgress: false });
		});
	}
}

class ItemsWidget extends preact.Component<{}, { items: ItemRecord[] }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { items: [] };
		concurrence.mysql.query("localhost", "SELECT id, text FROM concurrence_todo.items ORDER BY id DESC").then(result => {
			this.setState({ items: result as ItemRecord[] });
		});
	}
	render() {
		return <div>{this.state.items.map(item => <ItemWidget item={item}/>)}</div>;
	}
	receiveChannel: ConcurrenceChannel = concurrence.receive("item-changes", (message: ItemOperation) => {
		let items = this.state.items;
		switch (message.operation) {
			case "create": {
				let found = false;
				items = items.map(item => {
					if (item.id == message.record.id) {
						found = true;
						return message.record;
					}
					return item;
				});
				if (!found) {
					items = [message.record].concat(items);
				}
				break;
			}
			case "modify":
				items = items.map(item => item.id == message.record.id ? message.record : item);
				break;
			case "delete":
				items = items.filter(item => item.id != message.record.id);
				break;
		}
		this.setState({ items });
	});
	componentWillUnmount() {
		this.receiveChannel.close();
	}
}


concurrence.host((
	<div>
		<strong>Random numbers:</strong>
		<ShowHideWidget>
			<RandomWidget/>
		</ShowHideWidget>
		<strong>Messaging:</strong>
		<ShowHideWidget>
			<ReceiveWidget/>
		</ShowHideWidget>
		<BroadcastWidget/>
		<strong>To Do App:</strong>
		<ShowHideWidget>
			<NewItemWidget/>
			<ItemsWidget/>
		</ShowHideWidget>
	</div>
));

// Log current time
concurrence.now().then(value => console.log(value));
