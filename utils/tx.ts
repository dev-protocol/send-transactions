import {
	whenDefinedAll,
	whenNotError,
	whenNotErrorAll,
	type ErrorOr,
} from '@devprotocol/util-ts'
import BigNumber from 'bignumber.js'
import {
	JsonRpcProvider,
	TransactionResponse,
	type Contract,
	type ContractTransaction,
	type Signer,
} from 'ethers'
import type { ReadonlyDeep } from 'type-fest'
import { createClient } from 'redis'
import { generateTransactionKey } from './db'
import pRetry from 'p-retry'

// eslint-disable-next-line functional/type-declaration-immutability
type ContractMethod = Readonly<Contract['']>

// eslint-disable-next-line functional/type-declaration-immutability
export type PropsSend = ReadonlyDeep<{
	contract: Contract
	method: string
	signer: Signer
	chainId: number
	rpcUrl: string
	args: unknown[]
	gas?: {
		multiplier?: number
	}
	retry?: {
		attempts?: number
		interval?: number
	}
	redis: ReturnType<typeof createClient>
	requestId?: string
}>

// eslint-disable-next-line functional/type-declaration-immutability
type PropsCreateTx = Omit<
	PropsSend,
	'contract' | 'method' | 'signer' | 'redis' | 'requestId'
> &
	ReadonlyDeep<{
		contractMethod: ContractMethod
	}>

// eslint-disable-next-line functional/type-declaration-immutability
type PropsPureTx = ReadonlyDeep<{
	contractMethod: ContractMethod
	args: unknown[]
	feeData?: {
		gasLimit?: bigint
		maxFeePerGas?: bigint
		maxPriorityFeePerGas?: bigint
	}
}>

type GasStaionReturnValue = Readonly<{
	safeLow: Readonly<{
		maxPriorityFee: number
		maxFee: number
	}>
	standard: Readonly<{
		maxPriorityFee: number
		maxFee: number
	}>
	fast: Readonly<{
		maxPriorityFee: number
		maxFee: number
	}>
	estimatedBaseFee: number
	blockTime: number
	blockNumber: number
}>

const WeiPerGwei = '1000000000'

const pureTx = async ({
	contractMethod,
	args,
	feeData,
}: PropsPureTx): Promise<ErrorOr<ContractTransaction>> =>
	contractMethod.populateTransaction
		.apply(null, feeData ? [...args, feeData] : [...args])
		.then((res) => res)
		.catch((err: Error) => err)

const createTx = async ({
	contractMethod,
	chainId,
	rpcUrl,
	args,
	gas: { multiplier = 1.2 } = {},
}: PropsCreateTx): Promise<ErrorOr<ContractTransaction>> => {
	const feeDataFromGS = await (async (chainId_) => {
		const url =
			chainId_ === 137
				? 'https://gasstation.polygon.technology/v2'
				: chainId_ === 80001
					? 'https://gasstation-testnet.polygon.technology/v2'
					: new Error('Cannot found gas stasion URL')
		const gsRes = await whenNotError(url, (endpoint) =>
			fetch(endpoint).catch((err: Error) => err),
		)
		const result = await whenNotError(gsRes, (res) =>
			res
				.json()
				.then((x) => x as GasStaionReturnValue)
				.catch((err: Error) => err),
		)
		const multiplied = whenNotError(
			result,
			(_data) =>
				whenDefinedAll(
					[_data.fast.maxFee, _data.fast.maxPriorityFee],
					([maxFeePerGas, maxPriorityFeePerGas]) => ({
						maxFeePerGas: BigInt(
							new BigNumber(maxFeePerGas)
								.times(WeiPerGwei)
								.times(multiplier)
								.dp(0)
								.toFixed(),
						),
						maxPriorityFeePerGas: BigInt(
							new BigNumber(maxPriorityFeePerGas)
								.times(WeiPerGwei)
								.times(multiplier)
								.dp(0)
								.toFixed(),
						),
					}),
				) ?? new Error('Missing fee data: fast.maxFee, fast.maxPriorityFee'),
		)
		return multiplied
	})(chainId)

	const feeData =
		feeDataFromGS instanceof Error
			? await (async (rpcUrl_) => {
					const fromChain = await new JsonRpcProvider(rpcUrl_)
						.getFeeData()
						.catch((err: Error) => err)
					const multiplied = whenNotError(
						fromChain,
						(_data) =>
							whenDefinedAll(
								[_data.maxFeePerGas, _data.maxPriorityFeePerGas],
								([maxFeePerGas, maxPriorityFeePerGas]) => ({
									maxFeePerGas: BigInt(
										new BigNumber(maxFeePerGas.toString())
											.times(multiplier)
											.dp(0)
											.toFixed(),
									),
									maxPriorityFeePerGas: BigInt(
										new BigNumber(maxPriorityFeePerGas.toString())
											.times(multiplier)
											.dp(0)
											.toFixed(),
									),
								}),
							) ??
							new Error('Missing fee data: maxFeePerGas, maxPriorityFeePerGas'),
					)
					return multiplied
				})(rpcUrl)
			: feeDataFromGS

	const gasLimit =
		(await whenNotError(contractMethod, (contMethod) =>
			contMethod.estimateGas
				.apply(null, [...args])
				.then((res) => res)
				.catch((err: Error) => err),
		)) ?? new Error('The contract does not have the method')

	const multipliedGasLimit = whenNotError(gasLimit, (gas) =>
		BigInt(new BigNumber(gas.toString()).times(multiplier).dp(0).toFixed()),
	)

	const unsignedTx = await whenNotErrorAll(
		[multipliedGasLimit, feeData],
		([_gasLimit, { maxFeePerGas, maxPriorityFeePerGas }]) =>
			pureTx({
				contractMethod,
				args,
				feeData: { gasLimit: _gasLimit, maxFeePerGas, maxPriorityFeePerGas },
			}),
	)

	return unsignedTx
}

export const send = async ({
	contract,
	method,
	signer,
	chainId,
	rpcUrl,
	args,
	gas = { multiplier: 1.2 },
	retry: { attempts = 5, interval = 350 } = {},
	redis,
	requestId,
}: PropsSend): Promise<ErrorOr<TransactionResponse>> => {
	const contractMethod =
		contract[method] ?? new Error('The contract does not have the method.')
	const txBase = await whenNotError(contractMethod, (contMethod) =>
		pureTx({ contractMethod: contMethod, args }),
	)

	const prevTransaction = await whenNotErrorAll(
		[txBase, redis],
		([_tx, db]) =>
			whenDefinedAll([_tx.to, _tx.data], ([to, data]) =>
				db.get(generateTransactionKey(to, data, requestId)),
			) ??
			new Error(
				'Missing TransactionRequest field to get the prev transaction: .to, .data',
			),
	)

	const validExecutionInterval = whenNotError(prevTransaction, (ptx) => {
		const lasttime = typeof ptx === 'string' ? Number(ptx) : undefined
		const now = new Date().getTime()
		const oneMin = 60000
		const interval = now - (lasttime ?? 0)
		return interval > oneMin
			? true
			: new Error(`Invalid execution interval: ${interval}ms`)
	})

	const run = whenNotError(
		contractMethod,
		(contMethod) => async (attemptNumber: number) => {
			const unsignedTx = await createTx({
				contractMethod: contMethod,
				chainId,
				rpcUrl,
				args,
				gas,
			})
			const sentTx = await whenNotError(unsignedTx, (_tx) =>
				signer
					.sendTransaction(_tx)
					.then((res: TransactionResponse) => res)
					.catch((err: Error) => err),
			)
			// eslint-disable-next-line functional/no-expression-statements
			console.log('retry #', attemptNumber, sentTx)

			// eslint-disable-next-line functional/no-conditional-statements
			if (sentTx instanceof Error) {
				// eslint-disable-next-line functional/no-expression-statements
				await new Promise((resolve) => setTimeout(resolve, interval))
				// eslint-disable-next-line functional/no-throw-statements
				throw sentTx
			}
			return sentTx
		},
	)

	const result = await whenNotErrorAll(
		[validExecutionInterval, run],
		([, fn]) => pRetry(fn, { retries: attempts }),
	)

	return result
}
