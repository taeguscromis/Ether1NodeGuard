// Copyright (c) 2019, Taegus Cromis
//
// Please see the included LICENSE file for more information.

'use strict'

const child_process = require('child_process');
const vsprintf = require('sprintf-js').vsprintf;
const readline = require('readline');
const appRoot = require('app-root-path');
const request = require('request');
const moment = require('moment');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const RpcCommunicator = function(configOpts, errorCallback) {
  var getBlockOptions = {
    uri: "http://127.0.0.1:" + configOpts.node.port,
    method: 'POST',
    json: {
      "jsonrpc":"2.0",
      "method":"eth_blockNumber",
      "params":[],
      "id":1
    }
  }

  var isSyncedOptions = {
    uri: "http://127.0.0.1:" + configOpts.node.port,
    method: 'POST',
    json: {
      "jsonrpc":"2.0",
      "method":"eth_syncing",
      "params":[],
      "id":1
    }
  }

  var isRunning = false;
  var isSynced = false;
  var lastHeight = 0;
  var lastTS = moment();

  this.stop = function() {
    isRunning = false;
  }

  this.start = function() {
    isRunning = true;
    checkAliveAndWell();
  }

  this.getLastHeight = function() {
    return lastHeight;
  }

  function checkTheBlockHeight(currHeight) {
    if ((lastHeight != currHeight) || (currHeight == 0)) {
      lastHeight = currHeight;
      lastTS = moment();
      return true;
    } else {
      var duration = moment.duration(moment().diff(lastTS));

      if (duration.asSeconds() > (configOpts.restart.maxBlockTime || 1800)) {
        errorCallback("No new block has be seen for more then 30 minutes");
        return false;
      } else {
        return true;
      }
    }
  }

  function checkAliveAndWell() {
    if (isRunning) {
      if (!isSynced) {
        request(isSyncedOptions, function (error, response, data) {
          if (!error && response.statusCode == 200) {
            if (data.result) {
              if (checkTheBlockHeight(parseInt(data.result.currentBlock, 16))) {
                setTimeout(() => {
                  checkAliveAndWell();
                }, 5000);  
              }    
            } else {
              isSynced = true;
              checkAliveAndWell();
            }
          } else {
            errorCallback(error);
          }        
        });  
      } else {
        request(getBlockOptions, function (error, response, data) {
          if (!error && response.statusCode == 200) {
            if (checkTheBlockHeight(parseInt(data.result, 16))) {
              setTimeout(() => {
                checkAliveAndWell();
              }, 5000);  
            }
          } else {
            errorCallback(error);
          }
        });  
      }
    }  
  }
}

const NodeGuard = function () {
  var rootPath = null;

  if (appRoot.path.indexOf('app.asar') > -1) {
    rootPath = path.dirname(appRoot.path);
  } else {
    rootPath = appRoot.path;
  }

  // set the daemon path and start the node process
  const daemonPath = path.join(rootPath, 'geth');
  var configOpts = JSON.parse(fs.readFileSync(path.join(rootPath, 'config.json'), 'utf8'))
  var starupTime = moment();
  var errorCount = 0;
  var initialized = false;
  var nodeProcess = null;
  var RpcComms = null;
  var version = '';

  this.stop = function() {
    if (RpcComms) {
      RpcComms.stop();
      RpcComms = null;  
    }

    if (nodeProcess) {
      nodeProcess.kill('SIGTERM');
    }
  }

  function errorCallback(errorData) {
    restartDaemonProcess(errorData, true);
  }

  /***************************************************************
        log the error to text file and send it to Discord
  ***************************************************************/
 function logError(errorMsg, sendNotification) {
  var userDataDir = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : process.env.HOME + "/.local/share");
  userDataDir = path.join(userDataDir, "Ether1NodeGuard");

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir); 
  }   

  // write every error to a log file for possible later analization
  fs.appendFile(path.join(userDataDir, 'errorlog.txt'), errorMsg + "\n", function (err) {});

  // send notification if specified in the config
  if ((sendNotification) && (configOpts.notify.url)) {
    var hookOptions = {
      uri: configOpts.notify.url,
      method: 'POST',
      json: {
        "content": vsprintf('Node **%s** reported an error -> %s', [configOpts.node.name || os.hostname(), errorMsg + "\n"])
      }
    }
  
    request(hookOptions, function (error, response, data) {
      // for now its fire and forget, no matter if error occurs
    });    
  }
}

/***************************************************************
        restarts the node if an error occurs automatically
  ***************************************************************/
  function restartDaemonProcess(errorData, sendNotification) {
    logError(errorData, sendNotification);

    // increase error count and stop instance
    errorCount = errorCount + 1;
    guardInstance.stop();

    // check if we have crossed the maximum error number in short period
    if (errorCount > (configOpts.restart.maxCloseErrors || 3)) {
      logError("To many errors in a short ammount of time. Stopping.\n", true);
      process.exit(0);
    } else {
      startDaemonProcess();
    }

    setTimeout(() => {
      errorCount = errorCount - 1;
    }, (configOpts.restart.errorForgetTime || 600) * 1000);  
  }

  function checkIfInitialized() {
    if (!initialized) {
      var duration = moment.duration(moment().diff(starupTime));

      if (duration.asSeconds() > (configOpts.restart.maxInitTime || 600)) {
        restartDaemonProcess("Initialization is taking to long, restarting", true);
      } else {
        setTimeout(() => {
          checkIfInitialized();
        }, 5000);  
      }
    }
  }

  function startDaemonProcess() {
    nodeProcess = child_process.spawn(configOpts.node.path || daemonPath, configOpts.node.args || []);

    if (!nodeProcess) {
      logError("Failed to start the process instance. Stopping.\n", false);
      process.exit(0);
    } else {
      nodeProcess.on('error', function(err) {      
        restartDaemonProcess("Error on starting the node process", false);
      });
      nodeProcess.on('close', function(err) {      
        restartDaemonProcess("Node process closed with: " + err, true);
      });
  
      const dataStream = readline.createInterface({
        input: nodeProcess.stdout
      });
            
      const errorStream = readline.createInterface({
        input: nodeProcess.stderr
      });

      function processSingleLine(line) {
        if ((!version) && (line.search("Geth/v") > -1)) {
          var startIndex = line.search("Geth/v") + 6;
          var endIndex = startIndex + 5;
          version = line.substring(startIndex, endIndex);
        }

        // core is initialized, we can start the queries
        if (line.indexOf("Block synchronisation started") > -1) {
          setTimeout(() => {
            initialized = true;

            RpcComms = new RpcCommunicator(configOpts, errorCallback);
            RpcComms.start();
          }, 5000);  
        }
      }

      dataStream.on('line', (line) => {
        processSingleLine(line);
      });

      errorStream.on('line', (line) => {
        processSingleLine(line);      
      });

      // start the initilize checking
      checkIfInitialized();
    }
  }

  //create a server object if required
  if ((configOpts.api) && (configOpts.api.port)) {
    http.createServer(function (req, res) {
      if (req.url.toUpperCase() == '/GETINFO')
      {
        var statusResponse = {
          status: {
            name: configOpts.node.name || os.hostname(),
            errors: errorCount,
            startTime: starupTime,
            blockHeight: RpcComms ? RpcComms.getLastHeight() : 0,
            nodeVersion: version
          }
        }
    
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Powered-By':'nodejs'
        });
    
        // send the response payload
        res.write(JSON.stringify(statusResponse));
      } else {
        res.writeHead(403);
      }
  
      // finish
      res.end();  
    }).listen(configOpts.api.port);  
  }

  // start the process
  startDaemonProcess();
}

process.on('exit', function() {
  guardInstance.stop();
});

var guardInstance = new NodeGuard();