/* eslint-disable functional/no-expression-statements */
import { always } from 'ramda'
import { createClient } from 'redis'
import type { APIRoute, Params } from 'astro'
import { Contract, isAddress, type TransactionResponse } from 'ethers'

import { send } from 'utils/tx'
import { auth } from 'utils/auth'
import { json, headers } from 'utils/json'
import { createWallet } from 'utils/wallet'
import { generateTransactionKey } from 'utils/db'
import {
	whenDefined,
	whenNotError,
	type ErrorOr,
	whenDefinedAll,
	whenNotErrorAll,
} from '@devprotocol/util-ts'

import abi from './abi'

const { REDIS_URL, REDIS_USERNAME, REDIS_PASSWORD } = import.meta.env

type NumberAttribute = Readonly<{
	value: string
	trait_type: string
	display_type: string
}>

type StringAttribute = Readonly<{
	value: string
	trait_type: string
}>

export const POST: APIRoute = async ({
	request,
	params,
}: {
	request: Request
	params: Params
}) => {
	const isValidAuth = whenNotError(
		request,
		(_request) =>
			whenDefined(_request, (_r) =>
				auth(_r) ? true : new Error('Auth failed'),
			) ?? new Error('Auth failed'),
	)
	const isParamValid = whenNotError(
		params,
		(_params) =>
			whenDefined(_params, (_p) =>
				isAddress(_p.contract) ? true : new Error('Bad request data'),
			) ?? new Error('Bad request data'),
	)
	console.log('HERE1', { isValidAuth, isParamValid })
	const data = await whenNotErrorAll(
		[isValidAuth, request],
		async ([_iVA, _request]) =>
			whenDefinedAll([_iVA, _request], async ([, _r]) => {
				return !_r
					? new Error('Invalid metadata')
					: await _r
							.json()
							.then(
								(res) =>
									res as {
										reqId: string
										rpcUrl: string
										chainId: number
										metadata: Partial<{
											name: string
											description: string
											image: string
											numberAttributes: NumberAttribute[]
											stringAttributes: StringAttribute[]
										}>
										to: string
									},
							)
							.catch((err) => new Error(err))
			}) ?? new Error('Invalid metadata'),
	)
	console.log('HERE2', { data })
	const sbtContractAddress = whenNotErrorAll(
		[isParamValid, params],
		([_iPV, _params]) =>
			whenDefinedAll([_iPV, _params], ([, _p]) => {
				return !_p || !_p.contract
					? new Error('Invalid sbt contract address')
					: _p.contract
			}) ?? new Error('Invalid sbt contract address'),
	)
	console.log('HERE3', { sbtContractAddress })
	const wallet = whenNotErrorAll(
		[data],
		([{ rpcUrl }]) => createWallet({ rpcUrl }) ?? new Error('Wallet error'),
	)
	console.log('HERE4')
	const contract = whenNotErrorAll(
		[sbtContractAddress, wallet],
		([addr, wal]) => new Contract(addr, abi, wal),
	)
	console.log('HERE5')
	const redis = await whenNotError(
		createClient({
			url: REDIS_URL,
			username: REDIS_USERNAME ?? '',
			password: REDIS_PASSWORD ?? '',
		}),
		(db) =>
			db
				.connect()
				.then(always(db))
				.catch((err) => new Error(err)),
	)
	console.log('HERE6, redis === error', redis instanceof Error)
	const encodedMetadata = await whenNotErrorAll(
		[contract, wallet, data, redis],
		async ([contract_, , { metadata }]) => {
			return await contract_
				.getFunction('encodeMetadata')(
					metadata.name ?? '',
					metadata.description ?? '',
					metadata.stringAttributes ?? [],
					metadata.numberAttributes ?? [],
					metadata.image ?? '',
				)
				.then((res: string) => res)
				.catch((err: Error) => err)
		},
	)
	console.log('HERE7', { encodedMetadata })
	const tx = await whenNotErrorAll(
		[contract, wallet, data, redis, encodedMetadata],
		async ([
			contract_,
			signer,
			{ chainId, rpcUrl, reqId, to },
			db,
			encodedMetadata,
		]) => {
			return send({
				contract: contract_,
				method: 'mint',
				signer,
				chainId,
				rpcUrl,
				args: [to, encodedMetadata],
				requestId: reqId,
				redis: db,
			})
				.then((res: ErrorOr<TransactionResponse>) => res)
				.catch((err: Error) => err)
		},
	)
	console.log('HERE8', { tx })
	const sbtMintLog = await whenNotErrorAll(
		[contract, tx],
		async ([contract_, tx_]) => {
			const txReceipt = await tx_.wait(1)
			return !txReceipt
				? new Error('Invalid tx receipt')
				: (txReceipt.logs
						.map((log) => contract_.interface.parseLog(log))
						.find((log) => log?.name === 'Minted') ??
						new Error('SBT Mint log not found'))
		},
	)
	console.log('HERE9', { sbtMintLog })
	const sbtToBeMinted = whenNotErrorAll(
		[tx, sbtMintLog],
		([tx_, sbtMintLog_]) =>
			whenDefinedAll([tx_, sbtMintLog_], ([, ml]) =>
				Number(ml.args.at(0).toString()),
			) ?? new Error('SBT minted not found'),
	)
	console.log('HERE10', { sbtToBeMinted })
	const saved = await whenNotErrorAll(
		[tx, redis, data, sbtContractAddress, sbtToBeMinted],
		([_tx, db, { reqId }, ,]) =>
			whenDefinedAll([_tx.to, _tx.data], ([to, data]) =>
				db.set(generateTransactionKey(to, data, reqId), new Date().getTime()),
			) ??
			new Error(
				'Missing TransactionResponse field to save the transaction: .to, .data',
			),
	)
	console.log('HERE11', { saved })
	const result = await whenNotErrorAll([redis], ([db]) =>
		db
			.quit()
			.then((x) => x)
			.catch((err: Error) => err),
	)
	console.log('HERE12', { result })
	return result instanceof Error ||
		sbtToBeMinted instanceof Error ||
		saved instanceof Error
		? new Response(json({ message: 'Error occured', error: true }), {
				status: 500,
				headers,
			})
		: new Response(
				json({ message: 'success', claimedSBTTokenId: sbtToBeMinted }),
				{ status: 200, headers },
			)
}
