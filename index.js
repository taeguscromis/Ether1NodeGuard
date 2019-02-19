// Copyright (c) 2019, Taegus Cromis
//
// Please see the included LICENSE file for more information.

'use strict'

const child_process = require('child_process');
const readline = require('readline');
const appRoot = require('app-root-path');
const request = require('request');
const moment = require('moment');
const path = require('path');
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

  function checkTheBlockHeight(currHeight) {
    if ((lastHeight != currHeight) || (currHeight == 0)) {
      lastHeight = currHeight;
      lastTS = moment();
      return true;
    } else {
      var duration = moment.duration(moment().diff(lastTS));

      if (duration.asMinutes() > configOpts.restart.maxBlockTime) {
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
  var initialized = false;
  var nodeProcess = null;
  var RpcComms = null;

  this.stop = function() {
    if (RpcComms) {
      RpcComms.stop();
      RpcComms.destroy();  
    }

    if (nodeProcess) {
      nodeProcess.kill('SIGTERM');
    }
  }

  function errorCallback(errorData) {
    restartDaemonProcess(errorData, true);
  }

  /***************************************************************
        restarts the node if an error occurs automatically
  ***************************************************************/
  function restartDaemonProcess(errorData, sendNotification) {
    guardInstance.stop();

    // write every error to a log file for possible later analization
    fs.appendFile(path.join(rootPath, 'errorlog.txt'), errorData, function (err) {
    });

    // send notification if specified in the config
    if ((sendNotification) && (configOpts.notify.url)) {

    }

    // start the daemon again
    startDaemonProcess();
  }

  function checkIfInitialized() {
    if (!initialized) {
      var duration = moment.duration(moment().diff(starupTime));

      if (duration.asMinutes() > configOpts.restart.maxInitTime) {
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
      app.quit();
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

      dataStream.on('line', (line) => {
        // core is initialized, we can start the queries
        if (line.indexOf("Block synchronisation started") > -1) {
          setTimeout(() => {
            initialized = true;

            RpcComms = new RpcCommunicator(configOpts, errorCallback);
            RpcComms.start();
          }, 5000);  
        }
      });

      errorStream.on('line', (line) => {
        // core is initialized, we can start the queries
        if (line.indexOf("Block synchronisation started") > -1) {
          setTimeout(() => {
            initialized = true;

            RpcComms = new RpcCommunicator(configOpts, errorCallback);
            RpcComms.start();
          }, 5000);  
        }
      });

      // start the initilize checking
      checkIfInitialized();
    }
  }

  // start the process
  startDaemonProcess();
}

process.on('exit', function() {
  guardInstance.stop();
});

var guardInstance = new NodeGuard();