"use strict";

const INDEXEDDB_STORAGE_VERSION = 1;
const INDEXEDDB_STORAGE_NAME = "v86-filesystem-storage";
const INDEXEDDB_STORAGE_STORE = "store";
const INDEXEDDB_STORAGE_KEY_PATH = "sha256sum";
const INDEXEDDB_STORAGE_DATA_PATH = "data";
const INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH = "extra-block-count";
const INDEXEDDB_STORAGE_TOTALSIZE_PATH = "total-size";
const INDEXEDDB_STORAGE_GET_BLOCK_KEY = (sha256sum, block_number) => `${sha256sum}-${block_number}`;
const INDEXEDDB_STORAGE_CHUNKING_THRESHOLD = 4096;
const INDEXEDDB_STORAGE_BLOCKSIZE = 4096;

/** @interface */
function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.set = function(sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function(sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Uint8Array} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    return data.subarray(offset, offset + count);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage set: sha256sum should be a non-empty string");
    dbg_assert(!this.filedata.has(sha256sum), "MemoryFileStorage set: Storage should be read-only");

    this.filedata.set(sha256sum, data);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function(sha256sum)
{
    this.filedata.delete(sha256sum);
};

/**
 * Use IndexedDBFileStorage.try_create() instead.
 * @private
 * @constructor
 * @param {!IDBDatabase} db The IndexedDB database opened via init_db().
 * @implements {FileStorageInterface}
 */
function IndexedDBFileStorage(db)
{
    this.db = db;
}

IndexedDBFileStorage.try_create = async function() // jshint ignore:line
{
    if(typeof window === "undefined" || !window.indexedDB)
    {
        throw new Error("IndexedDB is not available");
    }
    const db = await IndexedDBFileStorage.init_db(); // jshint ignore:line
    const file_storage = new IndexedDBFileStorage(db);
    return file_storage;
}; // jshint ignore:line

/**
 * @return {!Promise<IDBDatabase>}
 */
IndexedDBFileStorage.init_db = function()
{
    return new Promise((resolve, reject) =>
    {
        const open_request = indexedDB.open(INDEXEDDB_STORAGE_NAME, INDEXEDDB_STORAGE_VERSION);

        open_request.onblocked = event =>
        {
            dbg_log("IndexedDB blocked by an older database version being opened.", LOG_9P);
        };

        open_request.onerror = event =>
        {
            dbg_log("Error opening IndexedDB! Are you in private browsing mode? Error:", LOG_9P);
            dbg_log(open_request.error, LOG_9P);
            reject(open_request.error);
        };

        open_request.onupgradeneeded = event =>
        {
            const db = open_request.result;
            db.createObjectStore(INDEXEDDB_STORAGE_STORE, { keyPath: INDEXEDDB_STORAGE_KEY_PATH });
        };

        open_request.onsuccess = event =>
        {
            const db = open_request.result;
            db.onabort = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: transaction aborted unexpectedly");
            };
            db.onclose = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: connection closed unexpectedly");
            };
            db.onerror = event =>
            {
                const error = event.originalTarget.error;
                dbg_log("IndexedDBFileStorage: unexpected error: " + error, LOG_9P);
                throw error;
            };
            db.onversionchange = event =>
            {
                dbg_log("Caution: Another v86 instance might be trying to upgrade the IndexedDB " +
                    "database to a newer version, or a request has been issued to delete the " +
                    "database, but is blocked by this current v86 instance ", LOG_9P);
            };
            resolve(db);
        };
    });
};

/**
 * @private
 * @param {IDBObjectStore} store
 * @param {string} key
 * @return {!Promise<Object>}
 */
IndexedDBFileStorage.prototype.db_get = function(store, key)
{
    return new Promise((resolve, reject) =>
    {
        const request = store.get(key);
        request.onsuccess = event => resolve(request.result);
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Uint8Array} null if file does not exist.
 */
IndexedDBFileStorage.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    dbg_assert(sha256sum, "IndexedDBFileStorage read: sha256sum should be a non-empty string");

    const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readonly");
    transaction.onerror = event =>
    {
        const error = event.originalTarget.error;
        dbg_log(`IndexedDBFileStorage read: Error with transaction: ${error}`, LOG_9P);
        throw error;
    };
    const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);

    const entry = await this.db_get(store, sha256sum); // jshint ignore:line

    if(!entry)
    {
        return null;
    }

    const base_data = entry[INDEXEDDB_STORAGE_DATA_PATH];
    const extra_block_count = entry[INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH];
    const total_size = entry[INDEXEDDB_STORAGE_TOTALSIZE_PATH];

    dbg_assert(base_data instanceof Uint8Array,
        `IndexedDBFileStorage read: Invalid base entry without the data Uint8Array field: ${base_data}`);
    dbg_assert(Number.isInteger(extra_block_count),
        `IndexedDBFileStorage read: Invalid base entry with non-integer block_count: ${extra_block_count}`);
    dbg_assert(Number.isInteger(total_size) && total_size >= base_data.length,
        `IndexedDBFileStorage read: Invalid base entry with invalid total_size: ${total_size}`);

    if(extra_block_count === 0 || offset + count <= base_data.length)
    {
        // Avoid additional allocation and copying for smaller files.
        return base_data.subarray(offset, offset + count);
    }

    const read_data = new Uint8Array(count);
    let read_count = 0;

    if(offset < base_data.length)
    {
        const chunk = base_data.subarray(offset, offset + count);
        read_data.set(chunk);
        read_count += chunk.length;
    }

    let block_number = Math.floor(
        (offset + read_count - base_data.length) /
        INDEXEDDB_STORAGE_BLOCKSIZE
    );
    for(; read_count < count && block_number < extra_block_count; block_number++)
    {
        const block_offset = base_data.length + block_number * INDEXEDDB_STORAGE_BLOCKSIZE;
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, block_number);
        const block_entry = await this.db_get(store, block_key); // jshint ignore:line

        dbg_assert(block_entry, `IndexedDBFileStorage read: Missing entry for block-${block_number}`);

        const block_data = block_entry[INDEXEDDB_STORAGE_DATA_PATH];
        dbg_assert(block_data instanceof Uint8Array,
            `IndexedDBFileStorage read: Entry for block-${block_number} without Uint8Array data field: ${block_data}`);

        const chunk_start = offset + read_count - block_offset;
        const chunk_end = offset + count - block_offset;
        const chunk = block_data.subarray(chunk_start, chunk_end);
        read_data.set(chunk, read_count);
        read_count += chunk.length;
    }

    return read_data.subarray(0, read_count);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
IndexedDBFileStorage.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    dbg_assert(sha256sum, "IndexedDBFileStorage set: sha256sum should be a non-empty string");

    const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readwrite");
    transaction.onerror = event =>
    {
        const error = event.originalTarget.error;
        dbg_log(`IndexedDBFileStorage set: Error with transaction: ${error}`, LOG_9P);
        throw error;
    };
    const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);

    const extra_block_count = Math.ceil(
        (data.length - INDEXEDDB_STORAGE_CHUNKING_THRESHOLD) /
        INDEXEDDB_STORAGE_BLOCKSIZE
    );

    store.put({ // jshint ignore:line
        [INDEXEDDB_STORAGE_KEY_PATH]: sha256sum,
        // Note: Without cloning, the entire backing ArrayBuffer is serialized into the database.
        [INDEXEDDB_STORAGE_DATA_PATH]: data.slice(0, INDEXEDDB_STORAGE_CHUNKING_THRESHOLD),
        [INDEXEDDB_STORAGE_TOTALSIZE_PATH]: data.length,
        [INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH]: extra_block_count,
    });

    let offset = INDEXEDDB_STORAGE_CHUNKING_THRESHOLD;
    for(let i = 0; offset < data.length; i++, offset += INDEXEDDB_STORAGE_BLOCKSIZE)
    {
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, i);
        // Note: Without cloning, the entire backing ArrayBuffer is serialized into the database.
        const block_data = data.slice(offset, offset + INDEXEDDB_STORAGE_BLOCKSIZE);
        store.put({ //jshint ignore:line
            [INDEXEDDB_STORAGE_KEY_PATH]: block_key,
            [INDEXEDDB_STORAGE_DATA_PATH]: block_data,
        });
    }

    await new Promise((resolve, reject) => { // jshint ignore:line
        transaction.oncomplete = event => resolve();
    });
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 */
IndexedDBFileStorage.prototype.uncache = function(sha256sum)
{
    // No-op.
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 */
function ServerFileStorageWrapper(file_storage, baseurl)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    this.storage = file_storage;
    this.baseurl = baseurl;
}

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.set(sha256sum, data).then(() => resolve(data));
        }});
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {Uint8Array}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    const data = await this.storage.read(sha256sum, offset, count); // jshint ignore:line
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum); // jshint ignore:line
        return full_file.subarray(offset, offset + count);
    }
    return data;
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    return await this.storage.set(sha256sum, data); // jshint ignore:line
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function(sha256sum)
{
    this.storage.uncache(sha256sum);
};

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["MemoryFileStorage"] = MemoryFileStorage;
    window["IndexedDBFileStorage"] = IndexedDBFileStorage;
    window["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["MemoryFileStorage"] = MemoryFileStorage;
    module.exports["IndexedDBFileStorage"] = IndexedDBFileStorage;
    module.exports["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["MemoryFileStorage"] = MemoryFileStorage;
    self["IndexedDBFileStorage"] = IndexedDBFileStorage;
    self["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
}
