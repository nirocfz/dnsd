// Copyright 2012 Iris Couch, all rights reserved.
//
// Test displaying DNS records

var util = require('util')

var parse = require('./parse')
var encode = require('./encode')
var constants = require('./constants')

module.exports = DNSMessage

var SECTIONS = ['question', 'answer', 'authority', 'additional']

// A DNS message.  This is an easy-to-understand object representation of
// standard DNS queries and responses.
//
// Attributes:
// * id                  - a number representing the unique query ID
// * type                - "request" or "response"
// * response            - Number (server response code)
// * opcode              - "query", "iquery", "status", "unassigned", "notify", "update"
// * authoritative       - Boolean
// * truncated           - Boolean
// * recursion_desired   - Boolean
// * recursion_available - Boolean
// * authenticated       - Boolean
// * checking_disabled   - Boolean
//
// Optional attributes:
// * question (optional) - Array of the question section
// * answer (optional) - Array of the answer section
// * authority (optional) - Array of the authority section
// * additional (optional) - Array of the additional section
//
// Methods:
// * toString() - return a human-readable representation of this message
// * toJSON() - Return a JSON-friendly represenation of this message
// * toBinary() - Return a buffer of the encoded message
function DNSMessage (body) {
  if(! Buffer.isBuffer(body))
    throw new Error('Must provide a buffer argument with message data')

  this.id = null
  this.type                = null
  this.responseCode        = null
  this.opcode              = null
  this.authoritative       = null
  this.truncated           = null
  this.recursion_desired   = null
  this.recursion_available = null
  this.authenticated       = null
  this.checking_disabled   = null

  this.parse(body)
}

DNSMessage.prototype.parse = function(body) {
  var self = this

  self.id = parse.id(body)

  var qr = parse.qr(body)
  self.type = (qr == 0) ? 'request' : 'response'

  self.responseCode = parse.rcode(body)

  var opcode_names = ['query', 'iquery', 'status', null, 'notify', 'update']
  var opcode = parse.opcode(body)
  self.opcode = opcode_names[opcode] || null

  self.authoritative       = !! parse.aa(body)
  self.truncated           = !! parse.tc(body)
  self.recursion_desired   = !! parse.rd(body)
  self.recursion_available = !! parse.ra(body)
  self.authenticated       = !! parse.ad(body)
  self.checking_disabled   = !! parse.cd(body)

  SECTIONS.forEach(function(section) {
    var count = parse.record_count(body, section)
    if(count) {
      self[section] = []
      for(var i = 0; i < count; i++)
        self[section].push(new DNSRecord(body, section, i))
    }
  })
}

DNSMessage.prototype.toBinary = function() {
  // The encoder is picky, so make sure it gets a valid message.
  var msg = JSON.parse(JSON.stringify(this))

  SECTIONS.forEach(function(section) {
    if(section == 'question')
      return

    msg[section] = msg[section] || []
    msg[section].forEach(function(record) {
      // Make sure records promising data have data.
      if(record.class == 'IN' && record.type == 'A')
        record.data = record.data || '0.0.0.0'

      // Convert SOA email addresses back to the dotted notation.
      if(record.class == 'IN' && record.type == 'SOA')
        record.data.rname = record.data.rname.replace(/@/g, '.')
    })
  })

  var state = new encode.State
  state.message(msg)
  return state.toBinary()
}

DNSMessage.prototype.toString = function() {
  var self = this

  var info = [ util.format('ID                 : %d', self.id)
             , util.format("Type               : %s", self.type)
             , util.format("Opcode             : %s", self.opcode)
             , util.format("Authoritative      : %s", self.authoritative)
             , util.format("Truncated          : %s", self.truncated)
             , util.format("Recursion Desired  : %s", self.recursion_desired)
             , util.format("Recursion Available: %s", self.recursion_available)
             , util.format("Response Code      : %d", self.responseCode)
             ]

  SECTIONS.forEach(function(section) {
    if(self[section]) {
      info.push(util.format(';; %s SECTION:', section.toUpperCase()))
      self[section].forEach(function(record) {
        info.push(record.toString())
      })
    }
  })

  return info.join('\n')
}


// An individual record from a DNS message
//
// Attributes:
// * name  - Host name
// * type  - Query type ('A', 'NS', 'CNAME', etc. or 'Unknown')
// * class - Network class ('IN', 'None' 'Unknown')
// * ttl   - Time to live for the data in the record
// * data  - The record data value, or null if not applicable
function DNSRecord (body, section_name, record_num, sections) {
  this.name = null
  this.type = null
  this.class = null

  // Leave these undefined for more consice and clear JSON serialization.
  //this.ttl  = null
  //this.data = null

  // sections is a cached previously-parsed object from the body.
  sections = sections || body

  this.parse(body, section_name, record_num, sections)
}

DNSRecord.prototype.parse = function(body, section_name, record_num, sections) {
  var self = this

  self.name = parse.record_name(sections, section_name, record_num)

  var clas = parse.record_class(sections, section_name, record_num)
  self.class = constants.class_to_label(clas)
  if(! self.class)
    throw new Error('Record '+record_num+' in section "'+section_name+'" has unknown class: ' + type)

  var type = parse.record_type(sections, section_name, record_num)
  self.type = constants.type_to_label(type)
  if(! self.type)
    throw new Error('Record '+record_num+' in section "'+section_name+'" has unknown type: ' + type)

  if(section_name == 'question')
    return

  self.ttl  = parse.record_ttl(sections, section_name, record_num)

  var rdata = parse.record_data(sections, section_name, record_num)
  switch (self.class + ' ' + self.type) {
    case 'IN A':
      if(rdata.length != 4)
        throw new Error('Bad IN A data: ' + JSON.stringify(self))
      self.data = inet_ntoa(rdata)
      break
    case 'IN NS':
    case 'IN CNAME':
    case 'IN PTR':
      self.data = parse.uncompress(body, rdata)
      break
    case 'IN MX':
      self.data = parse.mx(body, rdata)
      break
    case 'IN SOA':
      self.data = parse.soa(body, rdata)
      self.data.rname = self.data.rname.replace(/\./, '@')
      break
    case 'NONE A':
      self.data = []
      break
    default:
      throw new Error('Unknown record '+self.class+' '+self.type+': ' + JSON.stringify(self))
  }
}

DNSRecord.prototype.toString = function() {
  var self = this
  return [ width(23, self.name)
         , width( 7, self.ttl || '')
         , width( 7, self.class)
         , width( 7, self.type)
         , self.type == 'MX' && self.data
            ? (width(3, self.data[0]) + ' ' + self.data[1])
           : Buffer.isBuffer(self.data)
            ? self.data.toString('hex')
            : self.data || ''
         ].join(' ')
}

//
// Utilities
//

function width(str_len, str) {
  str = '' + str
  do {
    var needed = str_len - str.length
    if(needed > 0)
      str = ' ' + str
  } while(needed > 0)

  return str
}

function inet_ntoa(buf) {
  return buf[0] + '.' + buf[1] + '.' + buf[2] + '.' + buf[3]
}
