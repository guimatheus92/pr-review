// Test: would an inner BOM in the skill body cause issues?

// Simulate a skill body with an inner BOM
const skillBodyWithInnerBOM = `Some text\u{FEFF}More text`;

console.log("Original body:", JSON.stringify(skillBodyWithInnerBOM));
console.log("Trimmed body:", JSON.stringify(skillBodyWithInnerBOM.trim()));

// When injected into a markdown file:
const mdSection = ['', '## test', '_description_', '', skillBodyWithInnerBOM].join('\n');
console.log("\nMarkdown section:", JSON.stringify(mdSection));

// When read by a language model, the BOM is just a character (U+FEFF)
// It shouldn't break anything unless the model explicitly rejects it
// Most modern LLMs handle it gracefully as just whitespace
