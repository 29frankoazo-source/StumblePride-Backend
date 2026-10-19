class Console {
  static log(type, text, color, warp) {
    if (!color) {
      color = 34;
    }
    if (warp) {
      console.log(`\x1b\n[${color}m[${type}]\x1b[0m ` + text);
    } else {
      console.log(`\x1b[${color}m[${type}]\x1b[0m ` + text);
    }
  }
  static warn(type, text) {
    console.log(`\x1b[33m[${type}]\x1b[0m ` + text);
  }
  static error(type, text) {
    console.log(`\x1b[31m[${type}]\x1b[0m ` + text);
  }
}

module.exports = Console;
