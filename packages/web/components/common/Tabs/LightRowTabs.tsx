import React, { useMemo } from 'react';
import { Box, Flex, Grid, Image } from '@chakra-ui/react';
import type { FlexProps, GridProps } from '@chakra-ui/react';
import { useTranslation } from 'next-i18next';
import Avatar from '../Avatar';

type Props<ValueType = string> = Omit<GridProps, 'onChange'> & {
  list: { icon?: string; label: string | React.ReactNode; value: ValueType }[];
  value: ValueType;
  size?: 'sm' | 'md' | 'lg';
  inlineStyles?: FlexProps;
  activatedColor?: string;
  onChange: (value: ValueType) => void;
};

const LightRowTabs = <ValueType = string,>({
  list,
  size = 'md',
  value,
  activatedColor = 'primary.600',
  onChange,
  inlineStyles,
  ...props
}: Props<ValueType>) => {
  const { t } = useTranslation();
  const sizeMap = useMemo(() => {
    switch (size) {
      case 'sm':
        return {
          fontSize: 'xs',
          outP: '3px',
          inlineP: 1
        };
      case 'md':
        return {
          fontSize: 'sm',
          outP: '4px',
          inlineP: 1
        };
      case 'lg':
        return {
          fontSize: ['sm', 'md'],
          outP: '5px',
          inlineP: 2
        };
    }
  }, [size]);

  return (
    <Box overflow={'auto'}>
      <Grid
        gridTemplateColumns={`repeat(${list.length},1fr)`}
        p={sizeMap.outP}
        borderRadius={'sm'}
        fontSize={sizeMap.fontSize}
        userSelect={'none'}
        display={'inline-grid'}
        {...props}
      >
        {list.map((item) => (
          <Flex
            key={item.value as string}
            py={sizeMap.inlineP}
            alignItems={'center'}
            justifyContent={'center'}
            borderBottom={'2px solid transparent'}
            px={3}
            whiteSpace={'nowrap'}
            {...(value === item.value
              ? {
                  color: activatedColor,
                  cursor: 'default',
                  fontWeight: 'bold',
                  borderBottomColor: activatedColor
                }
              : {
                  cursor: 'pointer'
                })}
            onClick={() => {
              if (value === item.value) return;
              onChange(item.value);
            }}
            {...inlineStyles}
          >
            {item.icon && (
              <>
                <Avatar src={item.icon} alt={''} w={'1.25rem'} borderRadius={'sm'} mr={1} />
              </>
            )}
            <Box>{typeof item.label === 'string' ? t(item.label as any) : item.label}</Box>
          </Flex>
        ))}
      </Grid>
    </Box>
  );
};

export default LightRowTabs;
