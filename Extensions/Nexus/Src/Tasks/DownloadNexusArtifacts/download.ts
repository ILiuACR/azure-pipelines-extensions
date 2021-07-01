
var path = require('path')
var url = require('url')

import * as tl from 'vsts-task-lib/task';
import * as models from 'artifact-engine/Models';
import * as engine from 'artifact-engine/Engine';
import * as providers from 'artifact-engine/Providers';
import * as webHandlers from 'artifact-engine/Providers/typed-rest-client/Handlers';
import { ArtifactItem } from 'artifact-engine/Models';
import { ArtifactItemStore } from 'artifact-engine/Store/artifactItemStore';
import * as worker from 'artifact-engine/Engine/worker';

tl.setResourcePath(path.join(__dirname, 'task.json'));

var taskJson = require('./task.json');
const area: string = 'DownloadNexusArtifacts';

function getDefaultProps() {
    var hostType = (tl.getVariable('SYSTEM.HOSTTYPE') || "").toLowerCase();
    return {
        hostType: hostType,
        definitionName: '[NonEmail:' + (hostType === 'release' ? tl.getVariable('RELEASE.DEFINITIONNAME') : tl.getVariable('BUILD.DEFINITIONNAME')) + ']',
        processId: hostType === 'release' ? tl.getVariable('RELEASE.RELEASEID') : tl.getVariable('BUILD.BUILDID'),
        processUrl: hostType === 'release' ? tl.getVariable('RELEASE.RELEASEWEBURL') : (tl.getVariable('SYSTEM.TEAMFOUNDATIONSERVERURI') + tl.getVariable('SYSTEM.TEAMPROJECT') + '/_build?buildId=' + tl.getVariable('BUILD.BUILDID')),
        taskDisplayName: tl.getVariable('TASK.DISPLAYNAME'),
        jobid: tl.getVariable('SYSTEM.JOBID'),
        agentVersion: tl.getVariable('AGENT.VERSION'),
        agentOS: tl.getVariable('AGENT.OS'),
        agentName: tl.getVariable('AGENT.NAME'),
        version: taskJson.version
    };
}

function publishEvent(feature, properties: any): void {
    try {
        var splitVersion = (process.env.AGENT_VERSION || '').split('.');
        var major = parseInt(splitVersion[0] || '0');
        var minor = parseInt(splitVersion[1] || '0');
        let telemetry = '';
        if (major > 2 || (major == 2 && minor >= 120)) {
            telemetry = `##vso[telemetry.publish area=${area};feature=${feature}]${JSON.stringify(Object.assign(getDefaultProps(), properties))}`;
        }
        else {
            if (feature === 'reliability') {
                let reliabilityData = properties;
                telemetry = "##vso[task.logissue type=error;code=" + reliabilityData.issueType + ";agentVersion=" + tl.getVariable('Agent.Version') + ";taskId=" + area + "-" + JSON.stringify(taskJson.version) + ";]" + reliabilityData.errorMessage
            }
        }
        console.log(telemetry);;
    }
    catch (err) {
        tl.warning("Failed to log telemetry, error: " + err);
    }
}

async function main(): Promise<void> {
    var promise = new Promise<void>(async (resolve, reject) => {
        let connection = tl.getInput("connection", true);
        let repository = tl.getInput("definition", true);
        let packageName = tl.getInput("component", true);
        let version = tl.getInput("version", true);
        // let latestVersion =tl.getInput("latestversion", true);
        let itemPattern = tl.getInput("itemPattern", false);
        let downloadPath = tl.getInput("downloadPath", true);

        var endpointUrl = tl.getEndpointUrl(connection, false);
        var itemsUrl = endpointUrl + "repository/" + repository + "/" + packageName + "/" + version;
        // itemsUrl = itemsUrl.replace(/([^:]\/)\/+/g, "$1");
        console.log(tl.loc("DownloadArtifacts", itemsUrl));

        var templatePath = path.join(__dirname, 'nexus.handlebars');
        var username = tl.getEndpointAuthorizationParameter(connection, 'username', false);
        var password = tl.getEndpointAuthorizationParameter(connection, 'password', false);
        var nexusVariables = {
            "endpoint": {
                "url": endpointUrl
            }
        };
        var handler = new webHandlers.BasicCredentialHandler(username, password);
        var webProvider = new providers.WebProvider(itemsUrl, templatePath, nexusVariables, handler);
        var fileSystemProvider = new providers.FilesystemProvider(downloadPath);
        var parallelLimit : number = +tl.getVariable("release.artifact.download.parallellimit");

        var downloader = new engine.ArtifactEngine();
        var downloaderOptions = new engine.ArtifactEngineOptions();
        downloaderOptions.itemPattern = itemPattern ? itemPattern : '**';
        var debugMode = tl.getVariable('System.Debug');
        downloaderOptions.verbose = debugMode ? debugMode.toLowerCase() != 'false' : false;
        var parallelLimit : number = +tl.getVariable("release.artifact.download.parallellimit");
        
        if(parallelLimit){
            downloaderOptions.parallelProcessingLimit = parallelLimit;
        }

        await webProvider.getRootItem().then((itemToProcess: models.ArtifactItem) => {
            var artifactItemStore: ArtifactItemStore = new ArtifactItemStore();
            itemToProcess.path = packageName+"."+version+".nupkg";
            itemToProcess.itemType = models.ItemType.File;

            console.log(itemToProcess);
            const workers: Promise<void>[] = [];
            artifactItemStore.flush();

            engine.Logger.verbose = downloaderOptions.verbose;
            var logger = new engine.Logger(artifactItemStore);
            logger.logProgress();
            webProvider.artifactItemStore = artifactItemStore;
            fileSystemProvider.artifactItemStore = artifactItemStore;

            webProvider.getArtifactItem(itemToProcess).then((contentStream) => {
                artifactItemStore.addItem(itemToProcess);

                for (let i = 0; i < downloaderOptions.parallelProcessingLimit; ++i) {
                    var worker = new engine.Worker<models.ArtifactItem>(i + 1, item => processArtifactItem(webProvider, item, fileSystemProvider, downloaderOptions, artifactItemStore), () => artifactItemStore.getNextItemToProcess(), () => !artifactItemStore.itemsPendingProcessing(), () => artifactItemStore.hasDownloadFailed());
                    workers.push(worker.init());
                }

                Promise.all(workers).then(() => {
                    logger.logSummary();
                    webProvider.dispose();
                    fileSystemProvider.dispose();
                    resolve();
                }, (err) => {
                    // ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                    webProvider.dispose();
                    fileSystemProvider.dispose();
                    reject(err);
                });


                // engine.Logger.logInfo("Got download stream for item: " + itemToProcess.path);
                // fileSystemProvider.putArtifactItem(itemToProcess, contentStream)
                //     .then((item) => {
                //         artifactItemStore.updateState(item, models.TicketState.Processed);
                //         console.log("Successfully downloaded artifacts to " + downloadPath + itemToProcess.path);
                //         resolve();
                //     }, (err) => {
                //         console.log("Error placing file " + itemToProcess.path+ ": " + err);
                //     });
                // resolve();

            }, (err) => {
                console.log("Error getting file " + itemToProcess.path+ ": " + err);
                webProvider.dispose();
                fileSystemProvider.dispose();
                reject(err);
            });

        }).catch((error) => {
            reject(error);
        });
    });

    return promise;
}

function processArtifactItem(sourceProvider: models.IArtifactProvider,
    item: models.ArtifactItem,
    destProvider: models.IArtifactProvider,
    artifactEngineOptions: engine.ArtifactEngineOptions,
    artifactItemStore: ArtifactItemStore): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        processArtifactItemImplementation(sourceProvider, item, destProvider, artifactEngineOptions,artifactItemStore, resolve, reject);
    });
}

function processArtifactItemImplementation(sourceProvider: models.IArtifactProvider,
    item: models.ArtifactItem,
    destProvider: models.IArtifactProvider,
    artifactEngineOptions: engine.ArtifactEngineOptions,
    artifactItemStore: ArtifactItemStore,
    resolve,
    reject,
    retryCount?: number) {

    sourceProvider.getArtifactItem(item).then((contentStream) => {
        engine.Logger.logInfo("Got download stream for item: " + item.path);
        destProvider.putArtifactItem(item, contentStream)
            .then((item) => {
                artifactItemStore.updateState(item, models.TicketState.Processed);
                console.log("Successfully downloaded artifact: " + item.path);
                resolve();
            }, (err) => {
                engine.Logger.logInfo("Error placing file " + item.path + ": " + err);
                console.log("Error placing file " + item.path+ ": " + err);
            });
    }, (err) => {
        engine.Logger.logInfo("Error getting file " + item.path + ": " + err);
    });
}

main()
    .then((result) => {
        tl.setResult(tl.TaskResult.Succeeded, "");
    })
    .catch((err) => {
        publishEvent('reliability', { issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
        tl.setResult(tl.TaskResult.Failed, err);
    });