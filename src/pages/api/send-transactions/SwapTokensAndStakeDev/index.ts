import type { APIRoute } from 'astro'
import abi from './abi'
import { json, headers } from 'utils/json'
import { agentAddresses } from '@devprotocol/dev-kit/agent'
import { createWallet } from 'utils/wallet'
import { Contract, type TransactionResponse } from 'ethers'
import { auth } from 'utils/auth'
import {
	whenDefinedAll,
	whenNotErrorAll,
	whenNotError,
	type ErrorOr,
} from '@devprotocol/util-ts'
import { always } from 'ramda'
import { createClient } from 'redis'
import { generateTransactionKey } from 'utils/db'
import { send } from 'utils/tx'

const { REDIS_URL, REDIS_USERNAME, REDIS_PASSWORD } = import.meta.env

export const POST: APIRoute = async ({ request }) => {
	const authres = auth(request) ? true : new Error('authentication faild')

	const {
		requestId: requestId_,
		rpcUrl: rpcUrl_,
		chainId: chainId_,
		args: args_,
	} = ((await request.json()) as {
		requestId?: string
		rpcUrl?: string
		chainId?: number
		args?: {
			to: string
			property: string
			payload: string
			gatewayAddress: string
			amounts: {
				token: string
				input: string
				fee: string
			}
		}
	}) ?? {}

	const props = whenNotError(
		authres,
		always(
			whenDefinedAll([rpcUrl_, chainId_, args_], ([rpcUrl, chainId, args]) => ({
				requestId: requestId_,
				rpcUrl,
				chainId,
				args,
			})) ?? new Error('missing required parameter'),
		),
	)

	// eslint-disable-next-line functional/no-expression-statements
	console.log('@@@', { props })

	const address = whenNotError(props, ({ chainId }) =>
		chainId === 137
			? agentAddresses.polygon.mainnet.swapArbitraryTokens.swap
			: chainId === 80001
				? agentAddresses.polygon.mumbai.swapArbitraryTokens.swap
				: new Error(`unexpected chainId: ${chainId}`),
	)

	const wallet = whenNotError(
		props,
		({ rpcUrl }) => createWallet({ rpcUrl }) ?? new Error('wallet error'),
	)

	const contract = whenNotErrorAll(
		[address, wallet],
		([addr, wal]) => new Contract(addr, abi, wal),
	)

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

	const tx = await whenNotErrorAll(
		[contract, wallet, props, redis],
		([contract_, signer, { chainId, rpcUrl, args, requestId }, db]) =>
			send({
				contract: contract_,
				method: 'mintFor',
				signer,
				chainId,
				rpcUrl,
				args: [
					args.to,
					args.property,
					args.payload,
					args.gatewayAddress,
					args.amounts,
				],
				requestId,
				redis: db,
			})
				.then((res: ErrorOr<TransactionResponse>) => res)
				.catch((err: Error) => err),
	)

	const saved = await whenNotErrorAll(
		[tx, redis, props],
		([_tx, db, { requestId }]) =>
			whenDefinedAll([_tx.to, _tx.data], ([to, data]) =>
				db.set(
					generateTransactionKey(to, data, requestId),
					new Date().getTime(),
				),
			) ??
			new Error(
				'Missing TransactionResponse field to save the transaction: .to, .data',
			),
	)

	const result = await whenNotErrorAll([redis, saved], ([db]) =>
		db
			.quit()
			.then((x) => x)
			.catch((err: Error) => err),
	)

	// eslint-disable-next-line functional/no-expression-statements
	console.log({ tx, result, props })

	return result instanceof Error
		? new Response(json({ message: 'error', error: result.message }), {
				status: 400,
				headers,
			})
		: new Response(json({ message: 'success' }), { status: 200, headers })
}
