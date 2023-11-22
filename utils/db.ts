export const generateTransactionKey = (
	to: string,
	data: string,
	key: string = '',
): string => `transaction-created-time::${to}:${data}:${key}`
