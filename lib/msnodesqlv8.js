'use strict'

const msnodesql = require('msnodesqlv8');
const util = require('util');
const debug = require('debug')('mssql:msnodesql');

const base = require('./base');
const TYPES = require('./datatypes').TYPES;
const declare = require('./datatypes').declare;
const UDT = require('./udt').PARSERS;
const DECLARATIONS = require('./datatypes').DECLARATIONS;
const ISOLATION_LEVEL = require('./isolationlevel');

const EMPTY_BUFFER = new Buffer(0);
const JSON_COLUMN_ID = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B';
const XML_COLUMN_ID = 'XML_F52E2B61-18A1-11d1-B105-00805F49916B';

const CONNECTION_STRING_PORT = 'Driver={SQL Server Native Client 11.0};Server={#{server},#{port}};Database={#{database}};Uid={#{user}};Pwd={#{password}};Trusted_Connection={#{trusted}};';
const CONNECTION_STRING_NAMED_INSTANCE = 'Driver={SQL Server Native Client 11.0};Server={#{server}\\#{instance}};Database={#{database}};Uid={#{user}};Pwd={#{password}};Trusted_Connection={#{trusted}};';

const castParameter = function(value, type) {
	if (value == null) {
		if ((type === TYPES.Binary) || (type === TYPES.VarBinary) || (type === TYPES.Image)) {
			// msnodesql has some problems with NULL values in those types, so we need to replace it with empty buffer
			return EMPTY_BUFFER;
		}
		
		return null;
	}
	
	switch (type) {
		case TYPES.VarChar:
		case TYPES.NVarChar:
		case TYPES.Char:
		case TYPES.NChar:
		case TYPES.Xml:
		case TYPES.Text:
		case TYPES.NText:
			if ((typeof value !== 'string') && !(value instanceof String)) {
				value = value.toString();
			}
			break;
		
		case TYPES.Int:
		case TYPES.TinyInt:
		case TYPES.BigInt:
		case TYPES.SmallInt:
			if ((typeof value !== 'number') && !(value instanceof Number)) {
				value = parseInt(value);
				if (isNaN(value)) { value = null; }
			}
			break;
				
		case TYPES.Float:
		case TYPES.Real:
		case TYPES.Decimal:
		case TYPES.Numeric:
		case TYPES.SmallMoney:
		case TYPES.Money:
			if ((typeof value !== 'number') && !(value instanceof Number)) {
				value = parseFloat(value);
				if (isNaN(value)) { value = null; }
			}
			break;
		
		case TYPES.Bit:
			if ((typeof value !== 'boolean') && !(value instanceof Boolean)) {
				value = Boolean(value);
			}
			break;
		
		case TYPES.DateTime:
		case TYPES.SmallDateTime:
		case TYPES.DateTimeOffset:
		case TYPES.Date:
			if (!(value instanceof Date)) {
				value = new Date(value);
			}
			break;
		
		case TYPES.Binary:
		case TYPES.VarBinary:
		case TYPES.Image:
			if (!(value instanceof Buffer)) {
				value = new Buffer(value.toString());
			}
			break;
	}

	return value;
}

const createColumns = function(metadata) {
	let out = {};
	for (let index = 0, length = metadata.length; index < length; index++) {
		let column = metadata[index];
		out[column.name] = {
			index,
			name: column.name,
			length: column.size,
			type: DECLARATIONS[column.sqlType]
		}
		
		if (column.udtType != null) {
			out[column.name].udt = {
				name: column.udtType
			}
			
			if (DECLARATIONS[column.udtType]) {
				out[column.name].type = DECLARATIONS[column.udtType];
			}
		}
	}
			
	return out;
}

const isolationLevelDeclaration = function(type) {
	switch (type) {
		case ISOLATION_LEVEL.READ_UNCOMMITTED: return "READ UNCOMMITTED";
		case ISOLATION_LEVEL.READ_COMMITTED: return "READ COMMITTED";
		case ISOLATION_LEVEL.REPEATABLE_READ: return "REPEATABLE READ";
		case ISOLATION_LEVEL.SERIALIZABLE: return "SERIALIZABLE";
		case ISOLATION_LEVEL.SNAPSHOT: return "SNAPSHOT";
		default: throw new TransactionError("Invalid isolation level.");
	}
}

const valueCorrection = function(value, metadata) {
	if ((metadata.sqlType === 'time') && (value != null)) {
		value.setFullYear(1970);
		return value;
	} else if ((metadata.sqlType === 'udt') && (value != null)) {
		if (UDT[metadata.udtType]) {
			return UDT[metadata.udtType](value);
		} else {
			return value;
		}
	} else {
		return value;
	}
}

class ConnectionPool extends base.ConnectionPool {
	_poolCreate() {
		return new base.Promise((resolve, reject) => {
			debug('pool: create');
			
			let defaultConnectionString = CONNECTION_STRING_PORT;
			
			if (this.config.options.instanceName != null) {
				defaultConnectionString = CONNECTION_STRING_NAMED_INSTANCE;
			}
			
			const cfg = {
				conn_str: this.config.connectionString || defaultConnectionString,
				conn_timeout: (this.config.connectionTimeout || 15000) / 1000
			}
			
			cfg.conn_str = cfg.conn_str.replace(new RegExp('#{([^}]*)}', 'g'), (p) => {
				let key = p.substr(2, p.length - 3);
				
				switch (key) {
					case 'instance':
						return this.config.options.instanceName;
					case 'trusted':
						return this.config.options.trustedConnection ? 'Yes' : 'No';
					default:
						return this.config[key] != null ? this.config[key] : '';
				}
			})
			
			msnodesql.open(cfg, (err, tds) => {
				if (err) {
					err = new base.ConnectionError(err);
					return reject(err);
				}
				
				debug('pool: create ok');

				resolve(tds);
			})
		})
	}
	
	_poolValidate(tds) {
		return new base.Promise((resolve, reject) => {
			resolve(!tds.hasError);
		})
	}
	
	_poolDestroy(tds) {
		return new base.Promise((resolve, reject) => {
			debug('pool: destroy');
			
			tds.close();
			resolve();
		})
	}
}

class Transaction extends base.Transaction {
	_begin(isolationLevel, callback) {
		super._begin(isolationLevel, err => {
			if (err) return callback(err);
			
			debug('tran: begin');
			
			this.parent.acquire(this, (err, connection) => {
				if (err) return callback(err);
				
				this._acquiredConnection = connection;

				const req = new Request(this);
				req.stream = false;
				req.query(`set transaction isolation level ${isolationLevelDeclaration(this.isolationLevel)};begin tran;`, err => {
					if (err) {
						this.parent.release(this._acquiredConnection);
						this._acquiredConnection = null;
	
						return callback(err);
					}
					
					debug('tran: begin ok');

					callback(null);
				})
			})
		})
	}
		
	_commit(callback) {
		super._commit(err => {
			if (err) return callback(err);
			
			debug('tran: commit');
			
			const req = new Request(this);
			req.stream = false;
			req.query(`commit tran`, err => {
				if (err) err = new base.TransactionError(err);
				
				this.parent.release(this._acquiredConnection);
				this._acquiredConnection = null;
				
				if (!err) debug('tran: commit ok');

				callback(null);
			})
		})
	}

	_rollback(callback) {
		super._commit(err => {
			if (err) return callback(err);
			
			debug('tran: rollback');
			
			const req = new Request(this);
			req.stream = false;
			req.query(`rollback tran`, err => {
				if (err) err = new base.TransactionError(err);
				
				this.parent.release(this._acquiredConnection);
				this._acquiredConnection = null;
				
				if (!err) debug('tran: rollback ok');

				callback(null);
			})
		})
	}
}

class Request extends base.Request {
	_batch(batch, callback) {
		this._isBatch = true;
		this._query(batch, callback);
	}
		
	_bulk(table, callback) {
		super._bulk(table, err => {
			if (err) return callback(err);
			
			table._makeBulk();
			
			if (!table.name) {
				setImmedaite(callback, new base.RequestError("Table name must be specified for bulk insert.", "ENAME"));
			}
				
			if (table.name.charAt(0) === '@') {
				setImmediate(callback, new base.RequestError("You can't use table variables for bulk insert.", "ENAME"));
			}

			this.parent.acquire(this, (err, connection) => {
				if (!err) {
					const done = (err, rowCount) => {
						if (err) {
							if (('string' === typeof err.sqlstate) && (err.sqlstate.toLowerCase() === '08s01')) {
								connection.hasError = true;
							}
		
							err = new base.RequestError(err);
							err.code = 'EREQUEST';
						}

						this.parent.release(connection);
					
						if (err) {
							callback(e);
						} else {
							callback(null, table.rows.length);
						}
					};
					
					const go = () => {
						let tm = connection.tableMgr();
						return tm.bind(table.path.replace(/\[|\]/g, ''), mgr => {
							if (mgr.columns.length === 0) {
								return done(new base.RequestError("Table was not found on the server.", "ENAME"));
							}
							
							let rows = [];
							for (let row of Array.from(table.rows)) {
								let item = {};
								for (let index = 0; index < table.columns.length; index++) {
									let col = table.columns[index];
									item[col.name] = row[index];
								}
								
								rows.push(item);
							}
							
							mgr.insertRows(rows, done);
						})
					}
					
					if (table.create) {
						let objectid, req;
						if (table.temporary) {
							objectid = `tempdb..[${table.name}]`;
						} else {
							objectid = table.path;
						}
	
						return req = connection.queryRaw(`if object_id('${objectid.replace(/'/g, '\'\'')}') is null ${table.declare()}`, function(err) {
							if (err) { return done(err); }
							go();
						});
							
					} else {
						go();
					}
				}
			})
		})
	}
		
	_query(command, callback) {
		super._query(command, err => {
			if (err) return callback(err);
			
			debug('req: query');
			
			if (command.length === 0) {
				return callback(null, []);
			}

			let row = null;
			let columns = null;
			let recordset = null;
			const recordsets = [];
			const output = {};
			const rowsAffected = [];
			let handleOutput = false;
			let isChunkedRecordset = false;
			let chunksBuffer = null;
			
			// nested = function is called by this.execute
			
			if (!this._nested) {
				const input = [];
				for (let name in this.parameters) {
					let param = this.parameters[name];
					input.push(`@${param.name} ${declare(param.type, param)}`);
				}

				const sets = [];
				for (let name in this.parameters) {
					let param = this.parameters[name];
					if (param.io === 1) {
						sets.push(`set @${param.name}=?`);
					}
				}

				const output = [];
				for (let name in this.parameters) {
					let param = this.parameters[name];
					if (param.io === 2) {
						output.push(`@${param.name} as '${param.name}'`);
					}
				}

				if (input.length) command = `declare ${input.join(',')};${sets.join(';')};${command};`;
				if (output.length) {
					command += `select ${output.join(',')};`;
					handleOutput = true;
				}
			}
			
			this.parent.acquire(this, (err, connection) => {
				if (err) return callback(err);
				
				debug('req:connection acquired');
				
				const params = [];
				for (let name in this.parameters) {
					let param = this.parameters[name];
					if (param.io === 1) {
						params.push(castParameter(param.value, param.type));
					}
				}

				const req = connection.queryRaw(command, params);
				req.on('meta', metadata => {
					if (row) {
						if (isChunkedRecordset) {
							if ((columns[0].name === JSON_COLUMN_ID) && (this.connection.config.parseJSON === true)) {
								try {
									row = JSON.parse(chunksBuffer.join(''));
									if (!this.stream) { recordsets[recordsets.length - 1][0] = row; }
								} catch (ex) {
									row = null;
									ex = new base.RequestError(`Failed to parse incoming JSON. ${ex.message}`, 'EJSON');
									
									if (this.stream) {
										this.emit('error', ex);
									} else {
										console.error(ex);
									}
								}
							} else {
								row[columns[0].name] = chunksBuffer.join('');
							}
							
							chunksBuffer = null;
						}

						if (row.___return___ == null) {
							// row with ___return___ col is the last row
							if (this.stream) this.emit('row', row);
						}
					}
					
					row = null;
					columns = metadata;
					recordset = [];
					
					Object.defineProperty(recordset, 'columns', { 
						enumerable: false,
						configurable: true,
						value: createColumns(metadata)
					})
					
					isChunkedRecordset = false;
					if ((metadata.length === 1) && (metadata[0].name === JSON_COLUMN_ID || metadata[0].name === XML_COLUMN_ID)) {
						isChunkedRecordset = true;
						chunksBuffer = [];
					}
					
					if (this.stream) {
						if (recordset.columns.___return___ == null) {
							this.emit('recordset', recordset.columns);
						}
					} else {
						recordsets.push(recordset);
					}
				})
					
				req.on('row', rownumber => {
					if (row) {
						if (isChunkedRecordset) return;

						if (row.___return___ == null) {
							// row with ___return___ col is the last row
							if (this.stream) this.emit('row', row);
						}
					}
					
					row = {};
					
					if (!this.stream) recordset.push(row);
				})
					
				req.on('column', (idx, data, more) => {
					if (isChunkedRecordset) {
						chunksBuffer.push(data);
					} else {
						data = valueCorrection(data, columns[idx]);

						let exi = row[columns[idx].name];
						if (exi != null) {
							if (exi instanceof Array) {
								exi.push(data);
							} else {
								row[columns[idx].name] = [exi, data];
							}
						} else {
							row[columns[idx].name] = data;
						}
					}
				})
				
				req.on('rowcount', count => {
					rowsAffected.push(count);
				})
		
				req.once('error', err => {
					if (('string' === typeof err.sqlstate) && (err.sqlstate.toLowerCase() === '08s01')) {
						connection.hasError = true;
					}

					err = new base.RequestError(err);
					err.code = 'EREQUEST';

					this.parent.release(connection);
					
					debug('req: query failed', err);
					callback(err);
				})
				
				req.once('done', () => {
					if (!this._nested) {
						if (row) {
							if (isChunkedRecordset) {
								if ((columns[0].name === JSON_COLUMN_ID) && (this.connection.config.parseJSON === true)) {
									try {
										row = JSON.parse(chunksBuffer.join(''));
										if (!this.stream) { recordsets[recordsets.length - 1][0] = row; }
									} catch (ex) {
										row = null;
										ex = new base.RequestError(`Failed to parse incoming JSON. ${ex.message}`, 'EJSON');
										
										if (this.stream) {
											this.emit('error', ex);
										
										} else {
											console.error(ex);
										}
									}
								
								} else {
									row[columns[0].name] = chunksBuffer.join('');
								}
								
								chunksBuffer = null;
							}

							if (row["___return___"] == null) {
								// row with ___return___ col is the last row
								if (this.stream) { this.emit('row', row); }
							}
						}
	
						// do we have output parameters to handle?
						if (handleOutput) {
							let last = __guard__(recordsets.pop(), x => x[0]);
	
							for (let name in this.parameters) {
								let param = this.parameters[name];
								if (param.io === 2) {
									output[param.name] = last[param.name];
								}
							}
						}
					}

					this.parent.release(connection);
					
					debug('req: query ok');
					
					if (this.stream) {
						callback(null, this._nested ? row : null, output, rowsAffected);
					
					} else {
						callback(null, recordsets, output, rowsAffected);
					}
				});
			})
		})
	}

	_execute(procedure, callback) {
		super._execute(procedure, err => {
			if (err) return callback(err);

			const params = [];
			for (let name in this.parameters) {
				let param = this.parameters[name];
				if (param.io === 2) {
					params.push(`@${param.name} ${declare(param.type, param)}`);
				}
			}

			let cmd = `declare ${['@___return___ int'].concat(params).join(', ')};`;
			cmd += `exec @___return___ = ${procedure} `;
			
			const spp = [];
			for (let name in this.parameters) {
				let param = this.parameters[name];
						
				if (param.io === 2) {
					// output parameter
					spp.push(`@${param.name}=@${param.name} output`);
				} else {
					// input parameter
					spp.push(`@${param.name}=?`);
				}
			}
			
			const params2 = [];
			for (let name in this.parameters) {
				let param = this.parameters[name];
				if (param.io === 2) {
					params2.push(`@${param.name} as '${param.name}'`);
				}
			}
			
			cmd += `${spp.join(', ')};`;
			cmd += `select ${['@___return___ as \'___return___\''].concat(params2).join(', ')};`;

			this._nested = true;
			
			this._query(cmd, (err, recordsets, output, rowsAffected) => {
				this._nested = false;
				
				if (err) return callback(err);

				let last, returnValue;
				if (this.stream) {
					last = recordsets;
				} else {
					last = recordsets.pop()
					if (last) last = last[0];
				}
					
				if (last && (last.___return___ != null)) {
					returnValue = last.___return___;
					
					for (let name in this.parameters) {
						let param = this.parameters[name];
						if (param.io === 2) {
							output[param.name] = last[param.name];
						}
					}
				}

				if (this.stream) {
					callback(null, null, output, returnValue, rowsAffected);
				} else {
					callback(null, recordsets, output, returnValue, rowsAffected);
				}
			})
		})
	}
				
	/*
	Cancel currently executed request.
	*/
	
	cancel() {
		return false; // Request canceling is not implemented by msnodesql driver.
	}
}
	
module.exports = Object.assign({
	ConnectionPool,
	Transaction,
	Request,
	PreparedStatement: base.PreparedStatement
}, base.exports);

base.driver.ConnectionPool = ConnectionPool;
base.driver.Transaction = Transaction;
base.driver.Request = Request;

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}
function __guardFunc__(func, transform) {
  return typeof func === 'function' ? transform(func) : undefined;
}