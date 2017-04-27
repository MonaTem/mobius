// Basic render of static data
concurrence.render("#host", "Loading...");

// Basic fetch of data from the server
Promise.all([concurrence.random(), concurrence.random()]).then(function(value) {
	console.log(value);
	concurrence.render("#host", JSON.stringify(value));
});

// Stream of events from server to client
var randomStream;
function toggleRandoms() {
	if (randomStream) {
		console.log("Destroying random stream");
		randomStream.destroy();
		randomStream = null;
	} else {
		console.log("Starting random stream");
		randomStream = concurrence.interval(function() {
			concurrence.random().then(function(value) {
				concurrence.render("#host", value);
				console.log(value);
			});
		}, 1000);
	}
	concurrence.render("#toggle", randomStream ? "Stop" : "Start");
}
toggleRandoms();
var randomTransaction = concurrence.observe("#toggle", "click", toggleRandoms);

// Read input from the client
var logTransaction = concurrence.observe("#log", "click", function() {
	concurrence.read("#input").then(function(value) {
		console.log("Read input: " + value);
	});
});

// Receive broadcasted values
var receiveStream;
function toggleReceive() {
	if (receiveStream) {
		receiveStream.destroy();
		receiveStream = null;
	} else {
		receiveStream = concurrence.receive(function(value) {
			console.log("Receiving: " + value);
			concurrence.render("#broadcastField", value);
		});
	}
	concurrence.render("#connect", receiveStream ? "Disconnect" : "Connect");
}
toggleReceive();
var receiveTransaction = concurrence.observe("#connect", "click", toggleReceive);

// Broadcast when button is pressed
var broadcastTransaction = concurrence.observe("#broadcast", "click", function() {
	concurrence.read("#broadcastField").then(function(value) {
		console.log("Broadcasting: " + value);
		concurrence.broadcast(value);
	});
});

// Disconnect all events
var destroyTransaction = concurrence.observe("#destroy", "click", function() {
	// Force disconnect
	//concurrence.disconnect();
	// Graceful disconnect by destroying all server-side streams
	if (randomStream) {
		toggleRandoms();
	}
	randomTransaction.destroy();
	broadcastTransaction.destroy();
	if (receiveStream) {
		toggleReceive();
	}
	receiveTransaction.destroy();
	destroyTransaction.destroy();
	logTransaction.destroy();
});
