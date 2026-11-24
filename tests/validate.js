// Validates a GLB with the Khronos glTF validator. Prints JSON: { errors, warnings, messages }.
// The textures sit next to the GLB in the zip (relative URIs), so IO_ERROR for them is not counted.
// Usage: node tests/validate.js file.glb
const v = require('gltf-validator'), fs = require('fs');
v.validateBytes(new Uint8Array(fs.readFileSync(process.argv[2]))).then((r) => {
    const issues = r.issues.messages.filter((m) => m.code !== 'IO_ERROR');
    const messages = issues.filter((m) => m.severity <= 1).map((m) => `${m.code} ${m.pointer || ''}`);
    console.log(JSON.stringify({
        errors: issues.filter((m) => m.severity === 0).length,
        warnings: issues.filter((m) => m.severity === 1).length,
        messages,
    }));
});
