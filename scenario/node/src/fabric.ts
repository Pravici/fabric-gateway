/*
 * Copyright 2021 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures');

const dockerComposeDir = path.join(fixturesDir, 'docker-compose');
const dockerComposeFile = 'docker-compose-tls.yaml';

const tlsOptions = [
    '--tls', 'true',
    '--cafile', '/etc/hyperledger/configtx/crypto-config/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem',
];

interface OrgInfo {
    readonly orgName: string;
    readonly cli: string;
    readonly anchortx: string;
    readonly peers: string[];
}

const orgs: Record<string, OrgInfo> = {
    Org1MSP: {
        orgName: 'org1.example.com',
        cli: 'org1_cli',
        anchortx: '/etc/hyperledger/configtx/Org1MSPanchors.tx',
        peers: ['peer0.org1.example.com:7051', 'peer1.org1.example.com:9051'],
    },
    Org2MSP: {
        orgName: 'org2.example.com',
        cli: 'org2_cli',
        anchortx: '/etc/hyperledger/configtx/Org2MSPanchors.tx',
        peers: ['peer0.org2.example.com:8051', 'peer1.org2.example.com:10051'],
    },
    Org3MSP: {
        orgName: 'org2.example.com',
        cli: 'org3_cli',
        anchortx: '/etc/hyperledger/configtx/Org3MSPanchors.tx',
        peers: ['peer0.org3.example.com:11051'],
    },
};

export function getOrgForMsp(mspId: string): string {
    const org = orgs[mspId]?.orgName;
    if (!org) {
        throw new Error(`Unknown MSP: ${mspId}`);
    }

    return org;
}

export function findSoftHSMPKCS11Lib(): string {
    const commonSoftHSMPathNames = [
        '/usr/lib/softhsm/libsofthsm2.so',
        '/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so',
        '/usr/local/lib/softhsm/libsofthsm2.so',
        '/usr/lib/libacsp-pkcs11.so',
    ];

    for (const pathnameToTry of commonSoftHSMPathNames) {
        if (fs.existsSync(pathnameToTry)) {
            return pathnameToTry
        }
    }

    throw new Error('Unable to find PKCS11 library')
}

function dockerCommand(...args: string[]): string {
    const result = spawnSync('docker', args);
    const output = result.output.toString();
    console.log(output);
    // check return code
    return output;
}

function dockerCommandWithTLS(...args: string[]): string {
    const allArgs = args.concat(tlsOptions);
    return dockerCommand(...allArgs);
}

async function sleep(ms: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, ms));
}

export class Fabric {
    private fabricRunning = false;
    private channelsJoined = false;
    private readonly runningChaincodes: Record<string, string> = {};
    private readonly runningPeers: Record<string, boolean>;

    constructor() {
        this.runningPeers = Object.fromEntries(
            Object.values(orgs)
                .flatMap(org => org.peers)
                .map(hostPort => hostPort.split(':')[0])
                .map(host => [host, true])
        );
    }

    dockerDown(): void {
        const out = spawnSync('docker-compose', ['-f', dockerComposeFile, '-p', 'node', 'down'], { cwd: dockerComposeDir });
        console.log(out.output.toString());
    }

    async deployNetwork(): Promise<void> {
        if (this.fabricRunning) {
            return;
        }

        const generateOut = execFileSync('./generate.sh', { cwd: fixturesDir });
        console.log(generateOut.toString());

        const dockerComposeOut = spawnSync('docker-compose', ['-f', dockerComposeFile, '-p', 'node', 'up', '-d'], { cwd: dockerComposeDir });
        console.log(dockerComposeOut.output.toString());

        this.fabricRunning = true;
        await sleep(20000);
    }

    generateHSMUser(hsmuserid: string):void {
        const generateOut = execFileSync('./generate-hsm-user.sh', [hsmuserid], { cwd: fixturesDir });
        console.log(generateOut.toString());
    }

    async createChannels(): Promise<void> {
        await this.startAllPeers();

        if (this.channelsJoined) {
            return;
        }

        dockerCommandWithTLS(
            'exec', 'org1_cli',
            'peer', 'channel', 'create',
            '-o', 'orderer.example.com:7050',
            '-c', 'mychannel',
            '-f', '/etc/hyperledger/configtx/channel.tx',
            '--outputBlock', '/etc/hyperledger/configtx/mychannel.block'
        );

        for (const org of Object.values(orgs)) {
            for (const peer of org.peers) {
                const env = 'CORE_PEER_ADDRESS=' + peer;
                dockerCommandWithTLS(
                    'exec', '-e', env, org.cli,
                    'peer', 'channel', 'join',
                    '-b', '/etc/hyperledger/configtx/mychannel.block'
                );
            }

            dockerCommandWithTLS(
                'exec', org.cli, 'peer', 'channel', 'update',
                '-o', 'orderer.example.com:7050',
                '-c', 'mychannel',
                '-f', org.anchortx
            );
        }

        this.channelsJoined = true;
        await sleep(10000);
    }

    async deployChaincode(ccType: string, ccName: string, version: string, channelName: string, signaturePolicy: string): Promise<void> {
        let exists = false;
        let sequence = '1'
        const mangledName = ccName + version + channelName;
        const policy = this.runningChaincodes[mangledName];
        if (typeof policy !== 'undefined') {
            if (policy === signaturePolicy) {
                return;
            }
            // Already exists but different signature policy...
            // No need to re-install, just increment the sequence number and approve/commit new signature policy
            exists = true
            const out = dockerCommandWithTLS(
                'exec', 'org1_cli', 'peer', 'lifecycle', 'chaincode', 'querycommitted',
                '-o', 'orderer.example.com:7050', '--channelID', channelName, '--name', ccName);
            const pattern = new RegExp('.*Sequence: ([0-9]+),.*');
            const match = out.match(pattern);
            if (match === null || match.length < 2) {
                throw new Error(`Chaincode ${ccName} not found on org1 peers`);
            }
            sequence = (Number.parseInt(match[1]) + 1).toString();
        }

        const ccPath = `/opt/gopath/src/github.com/chaincode/${ccType}/${ccName}`;
        const ccLabel = `${ccName}v${version}`;
        const ccPackage = `${ccName}.tar.gz`;

        // is there a collections_config.json file?
        let collectionsConfig: string[] = [];
        const collectionsFile = `chaincode/${ccType}/${ccName}/collections_config.json`;
        if (fs.existsSync(path.join(fixturesDir, collectionsFile))) {
            collectionsConfig = ['--collections-config', path.join('/opt/gopath/src/github.com', collectionsFile)]
        }

        for (const [orgName, orgInfo] of Object.entries(orgs)) {
            if (!exists) {
                dockerCommand(
                    'exec', orgInfo.cli, 'peer', 'lifecycle', 'chaincode', 'package', ccPackage,
                    '--lang', ccType,
                    '--label', ccLabel,
                    '--path', ccPath);

                for (const peer of orgInfo.peers) {
                    const env = 'CORE_PEER_ADDRESS=' + peer;
                    dockerCommand('exec', '-e', env, orgInfo.cli, 'peer', 'lifecycle', 'chaincode', 'install', ccPackage);
                }
            }

            const out = dockerCommand('exec', orgInfo.cli, 'peer', 'lifecycle', 'chaincode', 'queryinstalled');

            const pattern = new RegExp('.*Package ID: (.*), Label: ' + ccLabel + '.*');
            const match = out.match(pattern);
            if (match === null || match.length < 2) {
                throw new Error(`Chaincode ${ccLabel} not found on ${orgName} peers`);
            }
            const packageID = match[1];

            dockerCommandWithTLS(
                'exec', orgInfo.cli,
                'peer', 'lifecycle', 'chaincode', 'approveformyorg',
                '--package-id', packageID,
                '--channelID', channelName,
                '--name', ccName,
                '--version', version,
                '--signature-policy', signaturePolicy,
                '--sequence', sequence,
                '--waitForEvent',
                ...collectionsConfig
            );
        }

        // commit
        dockerCommandWithTLS(
            'exec', 'org1_cli',
            'peer', 'lifecycle', 'chaincode', 'commit',
            '--channelID', channelName,
            '--name', ccName,
            '--version', version,
            '--signature-policy', signaturePolicy,
            '--sequence', sequence,
            '--waitForEvent',
            '--peerAddresses', 'peer0.org1.example.com:7051',
            '--peerAddresses', 'peer0.org2.example.com:8051',
            '--tlsRootCertFiles',
            '/etc/hyperledger/configtx/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt',
            '--tlsRootCertFiles',
            '/etc/hyperledger/configtx/crypto-config/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt',
            ...collectionsConfig
        );

        this.runningChaincodes[mangledName] = signaturePolicy;
        await sleep(10000);
    }

    stopPeer(peer: string): void {
        dockerCommand('stop', peer);
        this.runningPeers[peer] = false;
    }

    async startPeer(peer: string): Promise<void> {
        dockerCommand('start', peer);
        this.runningPeers[peer] = true;
        await sleep(20000);
    }

    private async startAllPeers(): Promise<void> {
        const stoppedPeers = Object.keys(this.runningPeers).filter(peer => !this.runningPeers[peer]);
        if (stoppedPeers.length === 0) {
            return;
        }

        for (const peer of stoppedPeers) {
            dockerCommand('start', peer);
            this.runningPeers[peer] = true;
        }
        await sleep(20000);
    }
}
