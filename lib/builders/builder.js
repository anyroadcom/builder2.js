var toArray = require('stream-to-array');
var parchan = require('parchan');
var saveTo = require('save-to');
var unglob = require('unglob');
var co = require('co');
var Readable = require('stream').Readable;
var inherits = require('util').inherits;
var resolve = require('path').resolve;

module.exports = Builder;

inherits(Builder, Readable);

/**
 * Easier than doing util.inherits.
 *
 * @param {Function} construct
 * @return {Function} construct
 * @api private
 */

Builder.extend = function (construct) {
  inherits(construct, this);
  return construct;
}

/**
 * The script and styles builder inherits from this.
 */

function Builder(branches, options) {
  Readable.call(this, options);

  // middleware
  this.fns = {};
  this.branches = branches;
  // in all builders, dev mode includes `.development` fields
  // in local components. `.development` fields are
  // always ignored in remote components.
  this.dev = !!(options.development || options.dev);
  // where the components are installed
  // bad name, but it's the same option name as resolver.js
  this.out = resolve(options.out || 'components');
  this.channel = parchan({
    // concurrency is pretty unnecessary here
    // thanks to graceful-fs
    concurrency: options.concurrency || 16,
    // this is an "open" channel until we manually close it.
    // kind of confusing - i probably need better terminology
    open: true
  })

  var self = this
  // the "push data to the channel" coroutine
  self.resolver(onerror)
  // the "push data from the channel to the stream" coroutine
  self.reader(onerror)

  function onerror(err) {
    if (err) self.emit('error', err)
  }
}

/**
 * Type: consumption utility.
 *
 * As well streaming the build,
 * you may also save it to a file or read it as a string.
 *
 * @param {Function} callback
 * @api public
 */

Builder.prototype.toStr = function (cb) {
  this.setEncoding('utf8')
  toArray(this, function (err, arr) {
    if (err) return cb(err)
    cb(null, arr.join(''))
  })

  return function (fn) {
    cb = fn
  }
}

/**
 * Type: consumption utility.
 *
 * Save the build to a file.
 * Note that it will save to a file regardless whether
 * it is empty or not.
 *
 * @param {String} filename
 * @param {Function} callback
 * @api public
 */

Builder.prototype.toFile = function (filename, cb) {
  saveTo(this, filename, function (err) {
    cb(err)
  })

  return function (fn) {
    cb = fn
  }
}

/**
 * Type: internal control flow.
 *
 * Coroutine that resolves all the components in series.
 * The only asynchronous function going on is unglobbing.
 *
 * @api private
 */

Builder.prototype.resolver = co(function* () {
  // wait for the user to attach middleware
  yield setImmediate;
  // to avoid doing this all the time
  this.fields = Object.keys(this.fns);
  var branches = this.branches;
  for (var i = 0; i < branches.length; i++) yield* this.resolve(branches[i]);
  // this tells the channel that there are no more
  // callbacks that will be pushed,
  // so the channel is no longer readable.
  this.channel.close();
})

/**
 * Type: internal control flow.
 *
 * Coroutine that reads data from the channel
 * and pushes it to the stream.
 *
 * @api private
 */

Builder.prototype.reader = co(function* () {
  var ch = this.channel;
  while (ch.readable) this.push(yield* ch.read());
  this.push(null);
})

/**
 * Unglob a "resolved" object.
 * This should only be necessary for local components.
 * This is the only "asynchronous" step in `.resolve()`.
 *
 * @param {Object} obj
 * @return {Object} files
 * @api private
 */

Builder.prototype.unglob = function* (obj) {
  var component = obj.component;
  // dev stuff is only relevant to local components
  var dev = obj.branch.type === 'local'
    && component.development
    || {};

  // unglob and concatenate all the relevant files per field
  var files = {};
  var fields = this.fields;
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var paths = [];
    if (component[field]) paths = paths.concat(component[field]);
    if (this.dev && dev[field]) paths = paths.concat(dev[field]);
    // note that at this point, `files` is an object
    // of generators and must be `yield`ed
    files[field] = unglob.directory(paths, obj.path);
  }
  // unglob all the fields in parallel
  return yield files;
}

/**
 * Push a function to the middleware based on `field`.
 * `fn` can either by a synchronous function,
 * an asynchronous function with callback,
 * or a generator function.
 *
 * synchronous and generator functions will be called with
 *
 *   fn.call(this, file)
 *
 * asynchronous will be called with
 *
 *   fn.call(this, file, function (err) {})
 *
 * @param {String} field
 * @param {Function} fn
 * @api public
 */

Builder.prototype.use = function (field, fn) {
  // handle multiple middleware at once like express
  if (arguments.length > 2) {
    [].slice.call(arguments, 1).forEach(function (fn) {
      this.use(field, fn);
    }, this);
    return;
  }

  var stacks = this.fns;
  var stack = stacks[field] = stacks[field] || [];
  stack.push(fn);
  return this;
}

/**
 * Runs all of `field`'s middleware on a file.
 *
 * @param {String} field
 * @param {Object} file
 * @api private
 */

Builder.prototype.transform = function* (field, file) {
  var fns = this.fns[field];
  for (var i = 0; i < fns.length; i++) {
    var fn = fns[i];
    // generator function
    if (isGeneratorFunction(fn)) yield* fn.call(this, file);
    // async function
    else if (fn.length === 2) yield fn.bind(this, file);
    // sync function
    else fn.call(this, file);
  }
}

/**
 * Push all the files of `files` split by fields's transforms to the channel.
 *
 * @param {Object} files
 * @api private
 */

Builder.prototype.dispatch = function (files) {
  var ch = this.channel;
  var fields = this.fields;
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var objs = files[field];
    for (var j = 0; j < objs.length; j++) {
      ch.push(co(this.append(field, objs[j])));
    }
  }
}

/**
 * Set the `._read` method to a `noop`
 * since this readable stream is not actually
 * "pulling" data.
 */

Builder.prototype._read = function () {}

/**
 * Check if an object is a Generator Function.
 *
 * @param {Object} obj
 * @return {Boolean}
 * @api private
 */

function isGeneratorFunction(obj) {
  return obj
    && obj.constructor
    && 'GeneratorFunction' === obj.constructor.name;
}