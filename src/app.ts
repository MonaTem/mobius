// Basic render of static data
concurrence.render("#host", "Loading...");

// Basic fetch of data from the server
Promise.all([concurrence.random(), concurrence.random()]).then(value => {
	console.log(value);
	concurrence.render("#host", JSON.stringify(value));
});

// Stream of events from server to client
var randomStream : any;
function toggleRandoms() {
	if (randomStream) {
		console.log("Destroying random stream");
		randomStream.close();
		randomStream = null;
	} else {
		console.log("Starting random stream");
		randomStream = concurrence.interval(() => {
			concurrence.random().then(value => {
				concurrence.render("#host", value.toString());
				console.log(value);
			});
		}, 1000);
	}
	concurrence.render("#toggle", randomStream ? "Stop" : "Start");
}
toggleRandoms();
var randomTransaction = concurrence.observe("#toggle", "click", toggleRandoms);

// Read input from the client
var logTransaction = concurrence.observe("#log", "click", () => {
	concurrence.read("#input").then(value => console.log("Read input: " + value));
});

// Receive broadcasted values
var receiveStream : ConcurrenceTransaction | undefined;
function toggleReceive() {
	if (receiveStream) {
		receiveStream.close();
		receiveStream = undefined;
	} else {
		receiveStream = concurrence.receive(value => {
			console.log("Receiving: " + value);
			concurrence.render("#broadcastField", value);
		});
	}
	concurrence.render("#connect", receiveStream ? "Disconnect" : "Connect");
}
toggleReceive();
var receiveTransaction = concurrence.observe("#connect", "click", toggleReceive);

// Broadcast when button is pressed
var broadcastTransaction = concurrence.observe("#broadcast", "click", () => {
	concurrence.read("#broadcastField").then(value => {
		console.log("Broadcasting: " + value);
		concurrence.broadcast(value);
	});
});

// Disconnect all events
var destroyTransaction = concurrence.observe("#destroy", "click", () => {
	// Force disconnect
	//concurrence.disconnect();
	// Graceful disconnect by destroying all server-side streams
	if (randomStream) {
		toggleRandoms();
	}
	randomTransaction.close();
	broadcastTransaction.close();
	if (receiveStream) {
		toggleReceive();
	}
	receiveTransaction.close();
	destroyTransaction.close();
	logTransaction.close();
});

concurrence.now().then(value => console.log(value));
