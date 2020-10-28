/*
Copyright 2020 IBM All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/

import { Signer } from './signer'
import { protosGateway } from './impl/protoutils'
import * as grpc from '@grpc/grpc-js';
import { Network } from './network';

export interface Builder {
    url(url: string): Builder;
    signer(signer: Signer): Builder;
    connect(): Gateway;
}

export class Gateway {
    _signer!: Signer;
    private stub: any;
    _evaluate: any;
    _endorse: any;
    _submit: any;

    private static BuilderImpl = class {
        _url: string = "";
        _signer!: Signer;
        
        url(url: string): Builder {
            this._url = url;
            return this;
        }

        signer(signer: Signer): Builder {
            this._signer = signer;
            return this;
        }

        connect(): Gateway {
            const gw = new Gateway();
            return gw.connect(this._url, this._signer);
        }
    }

    static createBuilder(): Builder {
        return new Gateway.BuilderImpl()
    }

    private constructor() { }

    private connect(url: string, signer: Signer): Gateway {
        if (url.length === 0) {
            throw new Error('Gateway URL not set');
        }
        if (typeof signer === 'undefined') {
            throw new Error('Gateway signer not set');
        }
        this._signer = signer;
        this.stub = new protosGateway(url, grpc.credentials.createInsecure());
        this._evaluate = (signedProposal: any) => {
            return new Promise((resolve, reject) => {
                this.stub.evaluate(signedProposal, function (err: any, result: any) {
                    if (err) reject(err);
                    resolve(result.value.toString());
                });
            })
        };
        this._endorse = (signedProposal: any) => {
            return new Promise((resolve, reject) => {
                this.stub.endorse(signedProposal, function (err: any, result: any) {
                    if (err) reject(err);
                    resolve(result);
                });
            })
        };
        this._submit = (preparedTransaction: any) => {
            return new Promise((resolve, reject) => {
                const call = this.stub.submit(preparedTransaction);
                call.on('data', function (event: any) {
                    console.log('Event received: ', event.value.toString());
                });
                call.on('end', function () {
                    resolve()
                });
                call.on('error', function (e: any) {
                    // An error has occurred and the stream has been closed.
                    reject(e);
                });
                call.on('status', function (status: any) {
                    // process status
                });
            })
        };
        return this;
    }

    getNetwork(networkName: string) {
        return new Network(networkName, this);
    }
}
