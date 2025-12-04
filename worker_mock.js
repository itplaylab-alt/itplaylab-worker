// worker_mock.js
console.log("🔧 Worker mock started.");

setInterval(() => {
  console.log("Worker heartbeat:", new Date().toISOString());
}, 5000);
